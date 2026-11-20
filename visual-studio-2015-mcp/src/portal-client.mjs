import http from 'node:http';
import https from 'node:https';
import { readFile, open, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { stableJson } from './canonical.mjs';
import { connectPinnedPortal } from './portal-tls.mjs';

export class PortalError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; Object.assign(this, details); }
}
export const portalFingerprint = value => createHash('sha256').update(stableJson(value)).digest('hex');
export function portalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new PortalError('PORTAL_URL_INVALID', 'Supply an explicit HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new PortalError('PORTAL_URL_INVALID', 'Use an HTTP(S) origin without credentials, paths, query or fragment.');
  return url.origin;
}

// No redirects, proxies, automatic retries, or global TLS changes. Each client
// owns its cookies and optional CA; secrets are read only from named variables.
export class PortalClient {
  constructor(config) { this.origin = portalOrigin(config.baseUrl); this.config = { ...config }; this.cookies = new Map(); this.closed = false; }
  async initialize() {
    if (this.origin.startsWith('http:') && this.config.allowInsecureHttp !== true)
      throw new PortalError('PORTAL_HTTP_CONSENT_REQUIRED', 'HTTP requires allowInsecureHttp:true for this explicit endpoint.');
    if (this.config.certificateSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(this.config.certificateSha256) || !this.origin.startsWith('https:') || this.config.caPath))
      throw new PortalError('PORTAL_TLS_CONFIG_INVALID', 'certificateSha256 requires an HTTPS origin, a lowercase SHA-256 leaf fingerprint, and no caPath.');
    if (Boolean(this.config.usernameEnv) !== Boolean(this.config.passwordEnv))
      throw new PortalError('PORTAL_CREDENTIALS_INVALID', 'Supply usernameEnv and passwordEnv together.');
    if (this.config.pairingPinEnv && (!this.origin.startsWith('https:') || this.config.usernameEnv))
      throw new PortalError('PORTAL_CREDENTIALS_INVALID', 'Mobile pairing requires HTTPS and cannot be combined with Basic credentials.');
    if (this.config.usernameEnv) {
      const user = process.env[this.config.usernameEnv], password = process.env[this.config.passwordEnv];
      if (!user || password === undefined || /[:\r\n]/.test(user)) throw new PortalError('PORTAL_CREDENTIALS_INVALID', 'The named credential environment variables are absent or invalid.');
      this.authorization = 'Basic ' + Buffer.from(user + ':' + password, 'utf8').toString('base64');
    }
    if (this.config.caPath) {
      const ca = await readFile(this.config.caPath);
      if (ca.length > 1048576) throw new PortalError('PORTAL_CA_INVALID', 'The CA file exceeds 1 MiB.');
      this.ca = ca;
    }
    return this;
  }
  async pairMobile(context) {
    const pin = process.env[this.config.pairingPinEnv];
    if (typeof pin !== 'string' || pin.length !== 6 || /[\x00-\x20\x7f]/.test(pin))
      throw new PortalError('PORTAL_CREDENTIALS_INVALID', 'The named Mobile pairing environment variable must contain the current six-character code.');
    // Protocol observed in the Mobile 14393 authenticate.js served by the device.
    // Nonpersistent cookie, one dispatch, no PIN or response cookies in results.
    await this.request('/authenticate.htm', { ...context, responseType: 'discard' });
    await this.request('/api/authorize/pair', { ...context, method: 'POST', mutation: true,
      query: { pin, persistent: '0' }, responseType: 'discard', acceptPairingCookies: true });
  }
  close() { this.closed = true; this.authorization = undefined; this.cookies.clear(); }
  async request(route, { method = 'GET', query = {}, signal, timeoutMs = 15000, destination, maxBytes = destination ? 536870912 : 8388608, mutation = false, responseType = 'json', acceptPairingCookies = false } = {}) {
    if (this.closed) throw new PortalError('PORTAL_CLOSED', 'The Portal connection is closed.');
    if (signal?.aborted) throw new PortalError('PORTAL_CANCELLED', 'Cancelled before dispatch.', { operationMayContinue: false });
    if (!route.startsWith('/') || route.startsWith('//')) throw new PortalError('PORTAL_ROUTE_INVALID', 'Invalid internal route.');
    const url = new URL(route, this.origin);
    if (url.origin !== this.origin) throw new PortalError('PORTAL_ROUTE_INVALID', 'The route changed origin.');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers = { Accept: destination ? '*/*' : 'application/json', 'User-Agent': 'VS2015-MCP' };
    if (this.authorization) headers.Authorization = this.authorization;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => key + '=' + value).join('; ');
    headers[method === 'GET' ? 'CSRF-Token' : 'X-CSRF-Token'] = this.cookies.get('CSRF-Token') ?? (method === 'GET' ? 'Fetch' : '');
    let dispatched = false, timer, file, temporary, pinnedSocket, pinnedAgent, bytes = 0;
    const startedAtUtc = new Date().toISOString();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (destination) { temporary = destination + '.' + randomUUID() + '.pending'; file = await open(temporary, 'wx'); }
      if (signal?.aborted) throw new PortalError('PORTAL_CANCELLED', 'Cancelled before dispatch.');
      timer = setTimeout(() => controller.abort(), timeoutMs);
      if (this.config.certificateSha256) {
        pinnedSocket = await connectPinnedPortal(url, this.config.certificateSha256, controller.signal);
        if (this.closed) throw new PortalError('PORTAL_CLOSED', 'The Portal connection closed before dispatch.');
        pinnedAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
        pinnedAgent.createConnection = () => pinnedSocket;
      }
      const response = await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers, agent: pinnedAgent ?? false, ca: this.ca, signal: controller.signal }, resolve);
        request.once('error', reject);
        // After end(), even a transport failure cannot prove non-execution.
        dispatched = true; request.end();
      });
      const status = response.statusCode;
      if (status !== 200) {
        response.destroy();
        let mobilePairing = false;
        if (status >= 300 && status < 400 && response.headers.location) {
          try { const location = new URL(response.headers.location, this.origin); mobilePairing = location.origin === this.origin && location.pathname === '/authenticate.htm'; } catch {}
        }
        const code = status === 401 || status === 403 || mobilePairing ? 'PORTAL_AUTH_REQUIRED' : status === 404 || status === 405 ? 'PORTAL_UNSUPPORTED' : status >= 300 && status < 400 ? 'PORTAL_REDIRECT_REFUSED' : 'PORTAL_HTTP_ERROR';
        throw new PortalError(code, `Device Portal returned HTTP ${status}.`, { details: { httpStatus: status, ...(mobilePairing ? { authentication: 'mobile-pairing' } : {}) } });
      }
      for (const cookie of response.headers['set-cookie'] ?? []) {
        const match = /^([!#$%&'*+.^_`|~\w-]+)=([^;\r\n]*)/.exec(cookie);
        if (!match) continue;
        const attributes = cookie.split(';').slice(1).map(part => part.trim());
        const domain = attributes.find(part => /^domain=/i.test(part))?.slice(7).toLowerCase().replace(/^\./, '');
        const cookiePath = attributes.find(part => /^path=/i.test(part))?.slice(5);
        if (domain && domain !== url.hostname.toLowerCase()) continue;
        const pairingCookie = acceptPairingCookies && url.protocol === 'https:' && cookiePath === '/';
        if (match[1] === 'CSRF-Token' || pairingCookie) this.cookies.set(match[1], match[2]);
      }
      const length = Number(response.headers['content-length']);
      if (Number.isFinite(length) && length > maxBytes) { response.destroy(); throw new PortalError('PORTAL_RESPONSE_TOO_LARGE', 'The response exceeds its byte limit.'); }
      const chunks = [], hash = createHash('sha256'); let prefix = Buffer.alloc(0);
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); throw new PortalError('PORTAL_RESPONSE_TOO_LARGE', 'The response exceeds its byte limit.'); }
        hash.update(chunk);
        if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
        if (file) await file.writeFile(chunk); else if (responseType !== 'discard') chunks.push(chunk);
      }
      const result = { bytes, sha256: hash.digest('hex'), contentType: response.headers['content-type'] ?? null,
        startedAtUtc, completedAtUtc: new Date().toISOString() };
      if (file) { await file.sync(); await file.close(); file = null; await rename(temporary, destination); temporary = null; return { ...result, path: destination, prefix }; }
      if (responseType === 'discard') return result;
      try { return { ...result, data: JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) }; }
      catch { throw new PortalError('PORTAL_RESPONSE_INVALID', 'Device Portal did not return valid JSON.'); }
    } catch (error) {
      const failure = error instanceof PortalError ? error : new PortalError(controller.signal.aborted ? (signal?.aborted ? 'PORTAL_CANCELLED' : 'PORTAL_TIMEOUT') : error.code?.startsWith('PORTAL_CERTIFICATE_') ? error.code : 'PORTAL_CONNECTION_FAILED',
        controller.signal.aborted ? 'The Device Portal request was interrupted.' : 'The Device Portal connection failed; check the endpoint and certificate.', { details: { causeCode: error.code ?? null } });
      failure.operationMayContinue = mutation && dispatched;
      throw failure;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      pinnedAgent?.destroy(); pinnedSocket?.destroy();
      await file?.close(); if (temporary) await rm(temporary, { force: true });
    }
  }
}

export function portalEtlEvidence(result) {
  const prefix = result.prefix;
  const bufferSize = prefix?.length >= 8 ? prefix.readUInt32LE(0) : 0;
  const filled = prefix?.length >= 8 ? prefix.readUInt32LE(4) : 0;
  const headerPlausible = bufferSize >= 4096 && bufferSize <= 16777216 && bufferSize % 1024 === 0 &&
    result.bytes >= bufferSize && filled >= 64 && filled <= bufferSize;
  const { prefix: ignored, ...evidence } = result;
  if (!headerPlausible) throw new PortalError('PORTAL_ETL_INVALID', 'The downloaded response does not have a plausible ETL buffer header.', { details: { artifact: evidence } });
  return { ...evidence, headerPlausible: true, eventContentValidated: false };
}

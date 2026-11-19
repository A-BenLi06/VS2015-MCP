import http from 'node:http';
import https from 'node:https';
import { readFile, open, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { stableJson } from './canonical.mjs';

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
    if (Boolean(this.config.usernameEnv) !== Boolean(this.config.passwordEnv))
      throw new PortalError('PORTAL_CREDENTIALS_INVALID', 'Supply usernameEnv and passwordEnv together.');
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
  close() { this.closed = true; this.authorization = undefined; this.cookies.clear(); }
  async request(route, { method = 'GET', query = {}, signal, timeoutMs = 15000, destination, maxBytes = destination ? 536870912 : 8388608, mutation = false } = {}) {
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
    let dispatched = false, timer, file, temporary, bytes = 0;
    const startedAtUtc = new Date().toISOString();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (destination) { temporary = destination + '.' + randomUUID() + '.pending'; file = await open(temporary, 'wx'); }
      if (signal?.aborted) throw new PortalError('PORTAL_CANCELLED', 'Cancelled before dispatch.');
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers, agent: false, ca: this.ca, signal: controller.signal }, resolve);
        request.once('error', reject);
        // After end(), even a transport failure cannot prove non-execution.
        dispatched = true; request.end();
      });
      const status = response.statusCode;
      if (status !== 200) {
        response.destroy();
        const code = status === 401 || status === 403 ? 'PORTAL_AUTH_REQUIRED' : status === 404 || status === 405 ? 'PORTAL_UNSUPPORTED' : status >= 300 && status < 400 ? 'PORTAL_REDIRECT_REFUSED' : 'PORTAL_HTTP_ERROR';
        throw new PortalError(code, `Device Portal returned HTTP ${status}.`, { details: { httpStatus: status } });
      }
      for (const cookie of response.headers['set-cookie'] ?? []) {
        const match = /^([!#$%&'*+.^_`|~\w-]+)=([^;\r\n]*)/.exec(cookie);
        if (match && match[1] === 'CSRF-Token') this.cookies.set(match[1], match[2]);
      }
      const length = Number(response.headers['content-length']);
      if (Number.isFinite(length) && length > maxBytes) { response.destroy(); throw new PortalError('PORTAL_RESPONSE_TOO_LARGE', 'The response exceeds its byte limit.'); }
      const chunks = [], hash = createHash('sha256'); let prefix = Buffer.alloc(0);
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); throw new PortalError('PORTAL_RESPONSE_TOO_LARGE', 'The response exceeds its byte limit.'); }
        hash.update(chunk);
        if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
        if (file) await file.writeFile(chunk); else chunks.push(chunk);
      }
      const result = { bytes, sha256: hash.digest('hex'), contentType: response.headers['content-type'] ?? null,
        startedAtUtc, completedAtUtc: new Date().toISOString() };
      if (file) { await file.sync(); await file.close(); file = null; await rename(temporary, destination); temporary = null; return { ...result, path: destination, prefix }; }
      try { return { ...result, data: JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) }; }
      catch { throw new PortalError('PORTAL_RESPONSE_INVALID', 'Device Portal did not return valid JSON.'); }
    } catch (error) {
      const failure = error instanceof PortalError ? error : new PortalError(controller.signal.aborted ? (signal?.aborted ? 'PORTAL_CANCELLED' : 'PORTAL_TIMEOUT') : 'PORTAL_CONNECTION_FAILED',
        controller.signal.aborted ? 'The Device Portal request was interrupted.' : 'The Device Portal connection failed; check the endpoint and certificate.', { details: { causeCode: error.code ?? null } });
      failure.operationMayContinue = mutation && dispatched;
      throw failure;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await file?.close(); if (temporary) await rm(temporary, { force: true });
    }
  }
}

export function portalEtlEvidence(result) {
  const prefix = result.prefix;
  const bufferSize = prefix?.length >= 8 ? prefix.readUInt32LE(0) : 0;
  const filled = prefix?.length >= 8 ? prefix.readUInt32LE(4) : 0;
  const headerPlausible = result.bytes >= 1024 && bufferSize >= 1024 && bufferSize <= 1048576 && filled >= 64 && filled <= bufferSize;
  const { prefix: ignored, ...evidence } = result;
  if (!headerPlausible) throw new PortalError('PORTAL_ETL_INVALID', 'The downloaded response does not have a plausible ETL buffer header.', { details: { artifact: evidence } });
  return { ...evidence, headerPlausible: true, eventContentValidated: false };
}

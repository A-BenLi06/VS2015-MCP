import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { PortalClient, PortalError, portalFingerprint, portalOrigin, portalEtlEvidence } from './portal-client.mjs';
import { createRun, readRun, runDirectory, saveArtifact } from './history.mjs';

const routes = Object.freeze({ os: '/api/os/info', packages: '/api/app/packagemanager/packages', processes: '/api/resourcemanager/processes',
  systemPerformance: '/api/resourcemanager/systemperf', etwProviders: '/api/etw/providers', profiles: '/perfprofiles/profiles.json', traceFiles: '/api/wpr/tracefiles' });
function requireThat(value, code, message) { if (!value) throw new PortalError(code, message); }
function statusOf(raw) {
  const state = raw?.SessionType === 'Running' ? 'recording' : raw?.SessionType === 'Idle' ? 'idle' : 'unknown';
  return { state, mode: raw?.State ?? null, raw, fingerprint: portalFingerprint(raw) };
}
function profileValue(catalog, pointer) {
  requireThat(typeof pointer === 'string' && pointer.startsWith('/') && !/~(?![01])/u.test(pointer), 'PORTAL_PROFILE_INVALID', 'profilePointer must identify a string in the observed profile catalog using JSON Pointer.');
  let value = catalog;
  for (const token of pointer.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    requireThat(value !== null && typeof value === 'object' && Object.hasOwn(value, token), 'PORTAL_PROFILE_INVALID', 'The selected profile is absent from the current catalog.');
    value = value[token];
  }
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/u.test(value), 'PORTAL_PROFILE_INVALID', 'The selected catalog value must be a nonempty profile name.');
  return value;
}
function traceItems(raw) {
  requireThat(Array.isArray(raw?.Items) && raw.Items.every(item => item && typeof item.Name === 'string' && item.Name && Number.isSafeInteger(item.FileSize) && item.FileSize >= 0),
    'PORTAL_TRACE_LIST_INVALID', 'The trace listing does not contain valid Items/Name/FileSize records.');
  return raw.Items;
}
const fileKey = item => portalFingerprint({ Name: item.Name, Id: item.Id ?? null, DateCreated: item.DateCreated ?? null, FileSize: item.FileSize });
const captureView = record => structuredClone(record);

// The parent PhoneSession queue owns serialization and checks VM/CoreCon identity.
// WDP has no remote ownership token: explicit exclusiveGuest is still required.
export class PortalSession {
  constructor(client, target, osInfo, runId, directory) {
    this.client = client; this.target = target; this.osInfo = osInfo; this.runId = runId; this.directory = directory;
    this.captures = new Map(); this.activeId = null;
  }
  static async connect(input, proof, identity, context, clientFactory = config => new PortalClient(config)) {
    const origin = portalOrigin(input.baseUrl), host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    requireThat(proof?.matched === true && net.isIP(host) && host === proof.guestAddress, 'PORTAL_TARGET_MISMATCH', 'Portal origin must use the exact guest IP observed by this CoreCon-bound phone session.');
    const client = await clientFactory(input).initialize();
    try {
      if (input.pairingPinEnv) await client.pairMobile(context);
      const osInfo = (await client.request(routes.os, context)).data;
      requireThat(osInfo && typeof osInfo.ComputerName === 'string' && osInfo.ComputerName && typeof osInfo.OsVersion === 'string' && osInfo.OsVersion,
        'PORTAL_IDENTITY_INVALID', 'Portal did not return an OS identity.');
      const run = input.runId ? await readRun(input.runId) : await createRun({ operation: 'phone:portal', context: { target: identity, origin, osInfo } });
      const directory = path.join(runDirectory(run.id), 'portal', randomUUID()); await mkdir(directory, { recursive: true });
      const transportTrust = input.certificateSha256 ? { mode: 'leaf-sha256', certificateSha256: input.certificateSha256 } : { mode: origin.startsWith('https:') ? 'certificate-authority' : 'explicit-http' };
      return new PortalSession(client, { ...identity, origin, guestAddress: proof.guestAddress, transportTrust }, osInfo, run.id, directory);
    } catch (error) { client.close(); throw error; }
  }
  public() { return { origin: this.client.origin, transportTrust: this.target.transportTrust, osInfo: this.osInfo, runId: this.runId, activeCapture: this.activeId ? captureView(this.captures.get(this.activeId)) : null }; }
  async validate(proof, context) {
    requireThat(proof?.matched === true && proof.guestAddress === this.target.guestAddress && proof.vmId?.toLowerCase() === this.target.vmId.toLowerCase(),
      'PORTAL_TARGET_CHANGED', 'The guest endpoint or VM changed after Portal connection.');
    const observed = (await this.client.request(routes.os, context)).data;
    requireThat(portalFingerprint(observed) === portalFingerprint(this.osInfo), 'PORTAL_IDENTITY_CHANGED', 'Device Portal OS identity changed. Reconnect explicitly.');
  }
  async save(record, state) {
    record.state = state; record.updatedAtUtc = new Date().toISOString();
    const temporary = record.receiptPath + '.' + randomUUID() + '.pending';
    await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx' }); await rename(temporary, record.receiptPath);
  }
  async status(context) {
    const status = statusOf((await this.client.request('/api/wpr/status', context)).data);
    const profiles = (await this.client.request(routes.profiles, context)).data;
    return { status, profiles, profilesFingerprint: portalFingerprint(profiles), activeCapture: this.activeId ? captureView(this.captures.get(this.activeId)) : null };
  }
  async start(input, context) {
    requireThat(input.exclusiveGuest === true, 'PORTAL_EXCLUSIVE_REQUIRED', 'Starting requires exclusive guest profiling.');
    requireThat(!this.activeId, 'PORTAL_CAPTURE_ACTIVE', 'This session already owns a possible recording.');
    const observed = await this.status(context);
    requireThat(observed.status.state === 'idle' && observed.status.mode === 'normal', 'PORTAL_WPR_NOT_IDLE', 'WPR must report Idle with normal mode before starting.');
    requireThat(observed.status.fingerprint === input.observedStatusFingerprint && observed.profilesFingerprint === input.profilesFingerprint,
      'PORTAL_OBSERVATION_CHANGED', 'WPR status or profile catalog changed; inspect fresh observations.');
    const profile = profileValue(observed.profiles, input.profilePointer);
    const beforeFiles = traceItems((await this.client.request(routes.traceFiles, context)).data);
    const captureId = randomUUID(), directory = path.join(this.directory, captureId); await mkdir(directory);
    const record = { captureId, state: 'prepared', operation: input.operation, profile, profilePointer: input.profilePointer, target: this.target,
      beforeFiles, receiptPath: path.join(directory, 'capture.json'), directory, createdAtUtc: new Date().toISOString(), trace: null, operationMayContinue: false };
    await this.save(record, 'prepared'); this.captures.set(captureId, record); this.activeId = captureId;
    try {
      record.operationMayContinue = true; await this.save(record, 'start-dispatching');
      const result = await this.client.request('/api/wpr/trace', { ...context, method: 'POST', query: { profile }, mutation: true });
      record.startInterval = { startedAtUtc: result.startedAtUtc, completedAtUtc: result.completedAtUtc };
      record.startStatus = statusOf(result.data);
      requireThat(record.startStatus.state === 'recording' && record.startStatus.mode === 'normal', 'PORTAL_START_UNCONFIRMED', 'Start did not confirm a normal running session.');
      await this.save(record, 'recording'); return captureView(record);
    } catch (error) {
      // Never turn an HTTP error after dispatch into permission to retry Start.
      await this.save(record, 'start-unconfirmed').catch(() => {});
      throw new PortalError('PORTAL_START_UNCONFIRMED', 'Start outcome is uncertain; inspect the capture receipt and status.',
        { operationMayContinue: true, details: { capture: captureView(record), causeCode: error.code } });
    }
  }
  owned(input) {
    const record = this.captures.get(input.captureId);
    requireThat(record, 'PORTAL_CAPTURE_NOT_OWNED', 'captureId is not owned by this Portal connection.'); return record;
  }
  async stop(input, context) {
    const record = this.owned(input);
    requireThat(input.exclusiveGuest === true, 'PORTAL_EXCLUSIVE_REQUIRED', 'Stopping requires continued exclusive guest profiling.');
    requireThat(this.activeId === record.captureId && ['recording', 'start-unconfirmed'].includes(record.state), 'PORTAL_STOP_REPLAY_REFUSED', 'Stop was already dispatched or this capture is no longer active.');
    const observed = statusOf((await this.client.request('/api/wpr/status', context)).data);
    requireThat(observed.state === 'recording' && observed.mode === 'normal', 'PORTAL_CAPTURE_CHANGED', 'The owned normal WPR recording is no longer observed.');
    try {
      await this.save(record, 'stop-dispatching');
      const result = await this.client.request('/api/wpr/trace', { ...context, mutation: true, destination: path.join(record.directory, 'stop-response.bin') });
      record.stopInterval = { startedAtUtc: result.startedAtUtc, completedAtUtc: result.completedAtUtc };
      // Some WDP versions return ETL directly; others write it and return no body.
      if (result.bytes > 0 && !/json|text|html/i.test(result.contentType ?? '')) {
        record.trace = portalEtlEvidence(result);
      } else if (result.bytes > 0) {
        requireThat(result.bytes <= 8388608, 'PORTAL_RESPONSE_TOO_LARGE', 'Stop response exceeds the JSON limit.');
        const raw = await readFile(result.path, 'utf8');
        try { record.stopResponse = JSON.parse(raw); } catch { throw new PortalError('PORTAL_RESPONSE_INVALID', 'Stop returned an unexpected body.'); }
        requireThat(record.stopResponse?.ErrorCode === undefined || record.stopResponse.ErrorCode === 0, 'PORTAL_STOP_UNCONFIRMED', 'Stop returned a native error.');
      }
      record.stopStatus = statusOf((await this.client.request('/api/wpr/status', context)).data);
      requireThat(record.stopStatus.state === 'idle', 'PORTAL_STOP_UNCONFIRMED', 'WPR did not confirm Idle after Stop.');
      record.operationMayContinue = false;
      await this.save(record, record.trace ? 'stopped-artifact-verified' : 'stopped'); this.activeId = null;
    } catch (error) {
      await this.save(record, 'stop-unconfirmed').catch(() => {});
      throw new PortalError('PORTAL_STOP_UNCONFIRMED', 'Stop may have executed. It will not be replayed; inspect status and the receipt.',
        { operationMayContinue: true, details: { capture: captureView(record), causeCode: error.code } });
    }
    if (!record.trace) {
      try { await this.refreshFiles(record, context); }
      catch (error) { record.artifactError = { code: error.code, message: error.message }; await this.save(record, 'stopped'); }
    }
    return captureView(record);
  }
  async refreshFiles(record, context) {
    const items = traceItems((await this.client.request(routes.traceFiles, context)).data);
    const before = new Set(record.beforeFiles.map(fileKey));
    record.candidateFiles = items.filter(item => !before.has(fileKey(item)));
    await this.save(record, record.state);
  }
  async download(input, context) {
    const record = this.owned(input);
    requireThat(record.state === 'stopped' || record.state === 'stopped-artifact-verified', 'PORTAL_CAPTURE_NOT_STOPPED', 'Download requires a confirmed stopped capture.');
    if (record.trace) return captureView(record);
    await this.refreshFiles(record, context);
    const matches = input.filename ? record.candidateFiles.filter(item => item.Name === input.filename) : record.candidateFiles;
    requireThat(matches.length === 1, 'PORTAL_TRACE_AMBIGUOUS', 'Select exactly one newly observed trace filename from candidateFiles.');
    const selected = matches[0];
    const result = await this.client.request('/api/wpr/tracefile', { ...context, query: { filename: selected.Name }, destination: path.join(record.directory, randomUUID() + '.etl') });
    requireThat(result.bytes === selected.FileSize, 'PORTAL_TRACE_CHANGED', 'Downloaded bytes do not match the observed trace file size.');
    record.trace = portalEtlEvidence(result); record.selectedFile = selected; delete record.artifactError;
    await this.save(record, 'stopped-artifact-verified'); return captureView(record);
  }
  async execute(input, context) {
    let result;
    try {
      if (input.action === 'read') {
        requireThat(Object.hasOwn(routes, input.resource), 'PORTAL_RESOURCE_INVALID', 'Unsupported read resource.');
        const response = await this.client.request(routes[input.resource], context); result = { resource: input.resource, ...response };
      } else if (input.action === 'status') result = await this.status(context);
      else if (input.action === 'start') result = await this.start(input, context);
      else if (input.action === 'stop') result = await this.stop(input, context);
      else if (input.action === 'download') result = await this.download(input, context);
      else throw new PortalError('PORTAL_ACTION_INVALID', 'Unknown Portal action.');
    } catch (error) { result = { error: { code: error.code ?? 'PORTAL_FAILED', message: error.message, operationMayContinue: error.operationMayContinue ?? false, details: error.details } }; }
    try {
      const artifact = await saveArtifact(this.runId, 'phone-portal', { action: input.action, result });
      return { ...result, runId: this.runId, artifactId: artifact.artifactId, artifactPath: artifact.path };
    } catch (error) { throw new PortalError('PORTAL_HISTORY_FAILED', 'The operation returned but history could not be saved.',
      { operationMayContinue: result.operationMayContinue ?? result.error?.operationMayContinue ?? false, details: { result, runId: this.runId } }); }
  }
  close() {
    this.client.close();
    return this.activeId ? [{ code: 'PORTAL_CAPTURE_MAY_CONTINUE', capture: captureView(this.captures.get(this.activeId)) }] : [];
  }
}

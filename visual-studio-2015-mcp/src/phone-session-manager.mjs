import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PhoneBridgeClient, createPhoneBridgeLauncher } from './phone-client.mjs';
import { appendEvent, createRun, readRun, runDirectory, saveArtifact } from './history.mjs';
import { PortalSession } from './portal-session.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const sameScalar = (a, b) => Object.is(a, b);
const guid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const windowsPath = value => typeof value === 'string' ? path.win32.normalize(value).toLowerCase() : null;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && windowsPath(a) === windowsPath(b);
const sameGuid = (a, b) => guid(a) && guid(b) && a.toLowerCase() === b.toLowerCase();
const resetCodes = new Set(['PHONE_BRIDGE_RESET', 'PHONE_BRIDGE_TIMEOUT', 'PHONE_BRIDGE_CLOSED', 'PHONE_BRIDGE_IO', 'PHONE_PROTOCOL_ERROR', 'PHONE_RESPONSE_TOO_LARGE']);
const invalidCodes = new Set([...resetCodes, 'PHONE_TARGET_CHANGED', 'PHONE_SESSION_NOT_FOUND', 'PHONE_CORECON_DISCONNECTED', 'PHONE_CHANNEL_TARGET_MISMATCH', 'PHONE_IDENTITY_INVALID', 'PHONE_MAPPING_INVALID']);
const beforeDispatchCodes = new Set([...invalidCodes, 'PHONE_SHELL_NOT_READY', 'PHONE_INVALID_KEYS', 'PHONE_KEY_NOT_HELD', 'PHONE_KEY_ALREADY_HELD', 'PHONE_UNKNOWN_OPERATION', 'PHONE_QUEUE_TIMEOUT', 'PHONE_QUEUE_FULL']);
export const PHONE_IDE_TOOL_ALLOWLIST = Object.freeze([
  'vs2015_solution_status', 'vs2015_solution_configurations', 'vs2015_project_properties', 'vs2015_project_app_identity',
  'vs2015_build_active', 'vs2015_project_build', 'vs2015_build_status', 'vs2015_build_reconcile', 'vs2015_ide_events',
  'vs2015_documents', 'vs2015_document_open', 'vs2015_document_read', 'vs2015_document_replace', 'vs2015_document_save', 'vs2015_document_edit',
  'vs2015_ide_errors_output', 'vs2015_ide_debug_state', 'vs2015_ide_debug_breakpoints', 'vs2015_ide_debug_control',
  'vs2015_ide_debug_inspect', 'vs2015_ide_debug_select_thread', 'vs2015_ide_debug_select_frame', 'vs2015_ide_debug_evaluate', 'vs2015_ide_debug_wait',
  'vs2015_ide_guest_app_identity', 'vs2015_ide_xaml_tree', 'vs2015_ide_xaml_action',
]);
export class PhoneSessionError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'PhoneSessionError'; this.code = code; Object.assign(this, details); }
}
function fail(code, message, details) { throw new PhoneSessionError(code, message, details); }
function check(condition, code, message) { if (!condition) fail(code, message); }
// Preserve the SDK's 100 ns process start identity. Date alone discards four digits.
export function utcIdentityTicks(value) {
  check(typeof value === 'string', 'PHONE_IDENTITY_INVALID', 'A UTC process start identity is required.');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const base = match ? Date.parse(match[1] + match[3]) : NaN;
  check(Number.isFinite(base), 'PHONE_IDENTITY_INVALID', 'Invalid process start timestamp.');
  return BigInt(base) * 10000n + BigInt((match[2] ?? '').padEnd(7, '0'));
}
function pinIdentity(identity) {
  check(identity && Number.isInteger(identity.processId) && identity.processId > 0 && guid(identity.vmId) &&
    ['vmName', 'executable', 'directory'].every(key => typeof identity[key] === 'string' && identity[key].length), 'PHONE_IDENTITY_INVALID', 'The SDK returned an incomplete emulator identity.');
  utcIdentityTicks(identity.startTimeUtc);
  return structuredClone(identity);
}
function sameIdentity(a, b) {
  return a.processId === b.processId && utcIdentityTicks(a.startTimeUtc) === utcIdentityTicks(b.startTimeUtc) && sameGuid(a.vmId, b.vmId) &&
    a.vmName === b.vmName && samePath(a.executable, b.executable) && samePath(a.directory, b.directory);
}
function checkedResult(result) {
  if (result?.error) { const error = result.error; throw new PhoneSessionError(error.code ?? 'PHONE_IDE_OPERATION_FAILED', error.message ?? 'The IDE operation failed.', error); }
  return result;
}
function errorWithDetails(error, extra = {}) {
  return new PhoneSessionError(error.code ?? 'PHONE_SESSION_ERROR', error.message ?? String(error), {
    ...(error.operationMayContinue !== undefined ? { operationMayContinue: error.operationMayContinue } : {}),
    ...(error.cleanupStatus !== undefined ? { cleanupStatus: error.cleanupStatus } : {}),
    ...(error.cleanupWarnings ?? error.backendError?.cleanupWarnings ? { cleanupWarnings: error.cleanupWarnings ?? error.backendError.cleanupWarnings } : {}),
    ...(error.backendError ? { backendError: error.backendError } : {}), ...extra,
  });
}
function combinedSignal(first, second) {
  const controller = new AbortController();
  const abortFirst = () => controller.abort(first.reason), abortSecond = () => controller.abort(second.reason);
  if (first?.aborted) abortFirst(); else first?.addEventListener('abort', abortFirst, { once: true });
  if (second?.aborted) abortSecond(); else second?.addEventListener('abort', abortSecond, { once: true });
  return { signal: controller.signal, dispose() { first?.removeEventListener('abort', abortFirst); second?.removeEventListener('abort', abortSecond); } };
}
function checkMapping(mapping, input, identity) {
  check(mapping && mapping.matched === true && mapping.method === 'sdk-endpoint-pair' && sameGuid(mapping.deviceId, input.coreConDeviceId) &&
    mapping.localeId === input.localeId && sameGuid(mapping.vmId, identity.vmId) && mapping.processId === identity.processId &&
    net.isIP(mapping.hostAddress) && net.isIP(mapping.guestAddress), 'PHONE_MAPPING_INVALID', 'The SDK did not prove the selected CoreCon locale/profile and XDE VM through both endpoint addresses.');
}
function bindingSnapshot(status, identity, binding, input) {
  check(status?.isOpen === true && typeof status.fullName === 'string' && status.fullName.length, 'PHONE_IDE_BINDING_INVALID', 'The bound IDE must have an open solution.');
  check(status.ideLocaleId === input.localeId && identity.ideLocaleId === input.localeId, 'PHONE_IDE_LOCALE_MISMATCH', 'CoreCon locale must equal the actual IDE locale.');
  check(status.configurationToken && status.configurationToken === identity.configurationToken, 'PHONE_IDE_CONFIGURATION_CHANGED', 'IDE configuration changed while reading the included manifest.');
  check(samePath(status.fullName, identity.solutionPath) && samePath(identity.projectUniqueName, binding.projectUniqueName), 'PHONE_IDE_BINDING_INVALID', 'The IDE project identity does not match the selected solution/project.');
  const projects = (status.projects ?? []).filter(project => samePath(project.uniqueName, binding.projectUniqueName));
  check(projects.length === 1 && samePath(projects[0].fileName, identity.projectPath), 'PHONE_IDE_BINDING_INVALID', 'The selected project is absent or its project path changed.');
  check(Array.isArray(status.startupProjects) && status.startupProjects.length === 1 && samePath(status.startupProjects[0], binding.projectUniqueName), 'PHONE_IDE_STARTUP_CHANGED', 'Phone IDE routing requires exactly the selected project as the startup project.');
  check(typeof identity.manifestPath === 'string' && /^[a-f0-9]{64}$/i.test(identity.manifestSha256 ?? '') &&
    identity.packageIdentity?.name && identity.packageIdentity?.publisher, 'PHONE_IDE_APP_IDENTITY_INVALID', 'The included saved project manifest did not provide a complete application identity.');
  check(['http://schemas.microsoft.com/appx/2010/manifest', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10'].includes(identity.manifestNamespace) && identity.source === 'included-project-item-saved-disk', 'PHONE_IDE_APP_IDENTITY_INVALID', 'The IDE identity must describe an included saved Appx manifest with its actual supported namespace.');
  if (identity.phoneIdentity) check(identity.phoneIdentity.namespace === 'http://schemas.microsoft.com/appx/2014/phone/manifest' && guid(identity.phoneIdentity.phoneProductId) && guid(identity.phoneIdentity.phonePublisherId), 'PHONE_IDE_APP_IDENTITY_INVALID', 'The phone identity must come from the actual Appx phone namespace and GUID attributes.');
  const applications = identity.applications ?? [];
  const selected = binding.applicationId ? applications.filter(app => app.id === binding.applicationId) : applications;
  check(selected.length === 1 && typeof selected[0].id === 'string' && selected[0].namespace === identity.manifestNamespace, 'PHONE_IDE_APPLICATION_AMBIGUOUS', 'Select one actual Application Id from the included project manifest.');
  check(Number.isInteger(identity.ideProcessId) && identity.ideStartTimeUtc, 'PHONE_IDE_BINDING_INVALID', 'The project identity did not include the actual IDE process identity.');
  utcIdentityTicks(identity.ideStartTimeUtc);
  return { configurationToken: identity.configurationToken, solutionPath: identity.solutionPath, projectPath: identity.projectPath,
    projectUniqueName: identity.projectUniqueName, manifestPath: identity.manifestPath, manifestSha256: identity.manifestSha256.toLowerCase(),
    ideProcessId: identity.ideProcessId, ideStartTimeUtc: identity.ideStartTimeUtc, applicationId: selected[0].id,
    manifestNamespace: identity.manifestNamespace, namespaceDeclarations: structuredClone(identity.namespaceDeclarations ?? {}),
    packageIdentity: structuredClone(identity.packageIdentity), phoneIdentity: structuredClone(identity.phoneIdentity ?? null) };
}
function sameBinding(a, b) {
  return a.configurationToken === b.configurationToken && samePath(a.solutionPath, b.solutionPath) && samePath(a.projectPath, b.projectPath) &&
    samePath(a.projectUniqueName, b.projectUniqueName) && samePath(a.manifestPath, b.manifestPath) && a.manifestSha256 === b.manifestSha256 &&
    a.ideProcessId === b.ideProcessId && utcIdentityTicks(a.ideStartTimeUtc) === utcIdentityTicks(b.ideStartTimeUtc) && a.applicationId === b.applicationId;
}
function verifyGuestApplication(snapshot, result) {
  if (result?.confirmed !== true || !result?.applicationIdentity) return { applicationVerification: 'unconfirmed', guestApplicationMatch: null };
  const observed = result.applicationIdentity;
  const parsedVersion = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(snapshot.packageIdentity?.version ?? '');
  const expectedVersion = parsedVersion ? { major: Number(parsedVersion[1]), minor: Number(parsedVersion[2]), build: Number(parsedVersion[3]), revision: Number(parsedVersion[4]) } : null;
  const mismatches = [];
  if (observed.packageName !== snapshot.packageIdentity?.name) mismatches.push('packageName');
  if (observed.publisher !== snapshot.packageIdentity?.publisher) mismatches.push('publisher');
  if (observed.applicationId !== snapshot.applicationId) mismatches.push('applicationId');
  if (!expectedVersion || !observed.version || observed.version.major !== expectedVersion.major || observed.version.minor !== expectedVersion.minor ||
      observed.version.build !== expectedVersion.build || observed.version.revision !== expectedVersion.revision) mismatches.push('version');
  const productIdVerified = Boolean(result.rawProductId?.available === true && snapshot.phoneIdentity?.phoneProductId);
  if (productIdVerified && !sameGuid(result.rawProductId.normalizedGuid, snapshot.phoneIdentity.phoneProductId)) mismatches.push('phoneProductId');
  if (mismatches.length) {
    throw new PhoneSessionError('PHONE_GUEST_APP_MISMATCH', 'The observed paused debuggee identity does not match the bound project manifest.', {
      backendError: { details: { mismatches, expectedManifest: { packageIdentity: snapshot.packageIdentity, applicationId: snapshot.applicationId, phoneIdentity: snapshot.phoneIdentity }, observedGuest: observed, rawProductId: result.rawProductId } },
    });
  }
  return {
    applicationVerification: 'guest-matched',
    guestApplicationMatch: { matched: true, pauseId: result.pauseId, programIdentityKey: result.programIdentityKey,
      packageName: observed.packageName, fullName: observed.fullName, applicationId: observed.applicationId, version: observed.version, productIdVerified },
  };
}

export class PhoneSessionManager {
  constructor({ clientFactory = () => new PhoneBridgeClient({ launch: createPhoneBridgeLauncher() }),
    ideInvoke = async () => fail('PHONE_IDE_UNAVAILABLE', 'No IDE bridge was supplied.'), ideDefinitions = [],
    ideToolAllowlist = PHONE_IDE_TOOL_ALLOWLIST, maxSessions = 8, maxQueuedPerSession = 64 } = {}) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 8) throw new RangeError('maxSessions must be 1..8.');
    if (!Number.isInteger(maxQueuedPerSession) || maxQueuedPerSession < 1 || maxQueuedPerSession > 256) throw new RangeError('maxQueuedPerSession must be 1..256.');
    this.clientFactory = clientFactory; this.ideInvoke = ideInvoke; this.ideDefinitions = new Map(ideDefinitions.map(tool => [tool.name, tool]));
    this.ideToolAllowlist = new Set(ideToolAllowlist); this.maxSessions = maxSessions; this.maxQueuedPerSession = maxQueuedPerSession;
    this.records = new Map(); this.closed = false;
  }
  assertAvailable(record, signal) {
    if (this.closed || record.state === 'stopped' || record.closing) fail('PHONE_SESSION_CLOSED', 'The MCP phone-session manager is closed.');
    if (signal?.aborted) fail('PHONE_SESSION_CANCELLED', 'The request was cancelled before the next dispatch.', { operationMayContinue: false });
    if (record.state === 'invalid') fail('PHONE_SESSION_INVALID', 'This session lost its pinned SDK identity. Close it and explicitly open a new session.', { reason: record.invalidReason });
    this.assertController(record);
  }
  assertController(record) {
    if (record.controllerPinned && (record.client.child !== record.controllerToken || record.client.ready !== true)) {
      record.state = 'invalid'; record.invalidReason = 'PHONE_BRIDGE_RESET'; record.transportInvalid = true;
      fail('PHONE_BRIDGE_RESET', 'The original SDK controller exited or changed. This session will not reconnect; close it and open explicitly.', { operationMayContinue: false });
    }
  }
  get(id) { const record = this.records.get(id); if (!record) fail('PHONE_SESSION_NOT_FOUND', 'Unknown phoneSessionId.'); return record; }
  public(record, result = {}) {
    const { sessionId: ignored, ...rest } = result;
    return { ...rest, phoneSessionId: record.id, applicationVerification: record.binding ? 'project-only' : 'unbound',
      ...(record.binding ? { ideBinding: { sessionId: record.binding.sessionId, ...record.snapshot } } : {}) };
  }
  async sdk(record, operation, input = {}, ctx = {}) {
    this.assertAvailable(record, ctx.signal);
    try { return await record.client.request(operation, input, { signal: ctx.signal, timeoutMs: ctx.timeoutMs ?? 15000 }); }
    catch (error) {
      if (invalidCodes.has(error.code)) { record.state = 'invalid'; record.invalidReason = error.code; record.transportInvalid ||= resetCodes.has(error.code); }
      throw error;
    }
  }
  async ideRead(record, operation, input, ctx) {
    this.assertAvailable(record, ctx.signal);
    return checkedResult(await this.ideInvoke(operation, { ...input, sessionId: record.binding.sessionId, timeoutMs: ctx.timeoutMs ?? 15000 }, ctx));
  }
  async readProperty(record, name, scope, ctx) {
    const result = await this.ideRead(record, 'projectProperties', { projectUniqueName: record.binding.projectUniqueName, scope, propertyName: name }, ctx);
    const matches = (result.properties ?? []).filter(property => property.name === name && property.available === true);
    check(matches.length === 1 && own(matches[0], 'value'), 'PHONE_IDE_PROPERTY_UNAVAILABLE', 'The actual target property is unavailable: ' + name);
    return matches[0].value;
  }
  async validateIde(record, ctx, initial = false) {
    if (!record.binding) return;
    const binding = record.binding;
    const status = await this.ideRead(record, 'solutionStatus', {}, ctx);
    const identity = await this.ideRead(record, 'projectAppIdentity', { projectUniqueName: binding.projectUniqueName,
      ...(binding.manifestPath ? { manifestPath: binding.manifestPath } : {}) }, ctx);
    const snapshot = bindingSnapshot(status, identity, binding, record.input);
    if (record.snapshot) check(sameBinding(record.snapshot, snapshot), 'PHONE_IDE_BINDING_CHANGED', 'The bound IDE configuration, solution, project, manifest or application identity changed.');
    check(sameGuid(await this.readProperty(record, binding.targetPropertyName, binding.scope, ctx), record.input.coreConDeviceId), 'PHONE_IDE_TARGET_CHANGED', 'The actual IDE target GUID no longer matches this phone session.');
    let guards = [...(binding.targetGuards ?? [])];
    // Discover names without invoking arbitrary legacy Value getters.
    for (const scope of ['activeConfiguration', 'project']) {
      const inventory = await this.ideRead(record, 'projectProperties', { projectUniqueName: binding.projectUniqueName, scope, limit: 500 }, ctx);
      check(inventory.truncated !== true, 'PHONE_IDE_PROPERTY_INVENTORY_TRUNCATED', 'The project target-property inventory was truncated.');
      for (const [name, value] of [['Debug.UseEmulator', true], ['Debug.UseSimulator', false]]) {
        if (inventory.properties?.some(property => property.name === name)) guards.push({ name, scope, value });
      }
    }
    if (record.guards) for (const guard of record.guards) if (!guards.some(current => current.name === guard.name && current.scope === guard.scope)) guards.push(guard);
    const distinctGuards = new Map();
    for (const guard of guards) {
      const key = JSON.stringify([guard.scope, guard.name]), previous = distinctGuards.get(key);
      check(!previous || sameScalar(previous.value, guard.value), 'PHONE_IDE_TARGET_GUARD_CONFLICT', 'Target property assertions conflict: ' + guard.name);
      distinctGuards.set(key, guard);
    }
    guards = [...distinctGuards.values()];
    check(guards.length <= 32, 'PHONE_IDE_TARGET_GUARD_LIMIT', 'At most 32 distinct target guards, including discovered SDK routing guards, can be bound.');
    for (const guard of guards) check(sameScalar(await this.readProperty(record, guard.name, guard.scope, ctx), guard.value), 'PHONE_IDE_TARGET_GUARD_CHANGED', 'The actual IDE target guard changed: ' + guard.name);
    // Re-read the short status after the property reads to reject drift during validation.
    const after = await this.ideRead(record, 'solutionStatus', {}, ctx);
    check(after.configurationToken === snapshot.configurationToken && samePath(after.fullName, snapshot.solutionPath) && after.ideLocaleId === record.input.localeId &&
      after.startupProjects?.length === 1 && samePath(after.startupProjects[0], binding.projectUniqueName), 'PHONE_IDE_BINDING_CHANGED', 'The IDE binding changed while it was being validated.');
    if (initial) record.snapshot = snapshot;
    record.guards = guards;
  }
  async validate(record, ctx, { skipIde = false } = {}) {
    this.assertAvailable(record, ctx.signal);
    const current = await this.sdk(record, 'identity', { sessionId: record.backendId }, ctx);
    try {
      check(sameIdentity(record.identity, pinIdentity(current.identity)), 'PHONE_TARGET_CHANGED', 'The SDK process/VM identity changed.');
      if (record.input.coreConDeviceId) checkMapping(current.crossChannelMapping, record.input, record.identity);
    } catch (error) { record.state = 'invalid'; record.invalidReason = error.code; throw error; }
    if (!skipIde) await this.validateIde(record, ctx);
    this.assertAvailable(record, ctx.signal);
    return current;
  }
  async open(input, context = {}) {
    if (this.closed) fail('PHONE_SESSION_CLOSED', 'The MCP phone-session manager is closed.');
    check(Number.isInteger(input.processId) && input.processId > 0 && guid(input.expectedVmId), 'PHONE_IDENTITY_REQUIRED', 'Explicit processId, expectedVmId and expectedStartTimeUtc are required.');
    utcIdentityTicks(input.expectedStartTimeUtc);
    check(Boolean(input.coreConDeviceId) === (input.localeId !== undefined), 'PHONE_MAPPING_REQUIRED', 'coreConDeviceId and localeId must be supplied together.');
    if (input.coreConDeviceId) check(guid(input.coreConDeviceId) && Number.isInteger(input.localeId) && input.localeId > 0 && input.localeId <= 65535, 'PHONE_MAPPING_REQUIRED', 'An exact CoreCon GUID and positive locale are required.');
    if (input.ideBinding) {
      check(input.coreConDeviceId && input.localeId, 'PHONE_MAPPING_REQUIRED', 'IDE binding requires CoreCon GUID/locale and SDK cross-channel mapping.');
      check(input.ideBinding.sessionId && input.ideBinding.projectUniqueName && input.ideBinding.targetPropertyName, 'PHONE_IDE_BINDING_REQUIRED', 'IDE session, actual project uniqueName and actual targetPropertyName are required.');
    }
    check(this.records.size < this.maxSessions, 'PHONE_SESSION_LIMIT', 'At most ' + this.maxSessions + ' phone sessions may be open.');
    check(![...this.records.values()].some(record => sameGuid(record.input.expectedVmId, input.expectedVmId) || record.input.processId === input.processId), 'PHONE_SESSION_TARGET_BUSY', 'This manager already has a session for the selected VM/process.');
    const record = { id: randomUUID(), input: structuredClone(input), binding: input.ideBinding ? structuredClone({ scope: 'activeConfiguration', ...input.ideBinding }) : null,
      state: 'opening', backendId: null, tail: Promise.resolve(), pending: 0, closing: false, stopController: new AbortController(), transportInvalid: false };
    if (record.binding?.targetGuards) record.binding.targetGuards = record.binding.targetGuards.map(guard => ({ scope: 'activeConfiguration', ...guard }));
    this.records.set(record.id, record);
    const joined = combinedSignal(context.signal, record.stopController.signal), ctx = { ...context, signal: joined.signal, timeoutMs: input.timeoutMs ?? 30000 };
    try {
      record.client = this.clientFactory({ phoneSessionId: record.id, input: record.input });
      check(record.client && typeof record.client.request === 'function' && typeof record.client.stop === 'function', 'PHONE_CLIENT_FACTORY_INVALID', 'clientFactory must synchronously create a dedicated bridge client.');
      await this.validateIde(record, ctx, true);
      this.assertAvailable(record, ctx.signal);
      const allowed = ['processId', 'expectedStartTimeUtc', 'expectedVmId', 'xdeRoots', 'coreConDeviceId', 'localeId', 'coreConServicePort'];
      const args = Object.fromEntries(allowed.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
      const result = await this.sdk(record, 'open', args, ctx); record.backendId = result.sessionId;
      if (own(record.client, 'child') && own(record.client, 'ready')) {
        record.controllerPinned = true; record.controllerToken = record.client.child;
        check(record.controllerToken && record.client.ready === true, 'PHONE_BRIDGE_RESET', 'The SDK controller exited while opening the phone session.');
      }
      check(typeof record.backendId === 'string' && record.backendId.length, 'PHONE_IDENTITY_INVALID', 'The SDK did not return a session handle.');
      record.identity = pinIdentity(result.identity);
      check(record.identity.processId === input.processId && utcIdentityTicks(record.identity.startTimeUtc) === utcIdentityTicks(input.expectedStartTimeUtc) && sameGuid(record.identity.vmId, input.expectedVmId), 'PHONE_TARGET_CHANGED', 'The SDK open result did not match the explicitly selected process/start/VM.');
      if (input.coreConDeviceId) checkMapping(result.crossChannelMapping, input, record.identity);
      await this.validateIde(record, ctx);
      this.assertAvailable(record, ctx.signal); record.state = 'open';
      return this.public(record, result);
    } catch (error) {
      if (resetCodes.has(error.code)) record.transportInvalid = true;
      if (record.controllerPinned && (record.client.child !== record.controllerToken || record.client.ready !== true)) record.transportInvalid = true;
      let cleanup, close;
      if (record.backendId && !record.transportInvalid && !this.closed) try { close = await record.client.request('close', { sessionId: record.backendId }, { timeoutMs: 5000 }); } catch (failure) { close = { error: { code: failure.code, message: failure.message } }; }
      try { cleanup = await record.client?.stop(); } catch (failure) { cleanup = { cleanupStatus: 'unknown', error: failure.message }; }
      this.records.delete(record.id);
      throw errorWithDetails(error, { cleanupDetails: { close, shutdown: cleanup } });
    } finally { joined.dispose(); }
  }
  enqueue(id, input, context, operation) {
    const record = this.get(id);
    if (record.closing || this.closed) return Promise.reject(new PhoneSessionError('PHONE_SESSION_CLOSED', 'This phone session is closing.'));
    if (record.pending >= this.maxQueuedPerSession) return Promise.reject(new PhoneSessionError('PHONE_SESSION_QUEUE_FULL', 'The phone session command queue is full.'));
    record.pending++;
    const joined = combinedSignal(context?.signal, record.stopController.signal), ctx = { ...context, signal: joined.signal, timeoutMs: input.timeoutMs ?? 15000 };
    const run = record.tail.then(async () => { this.assertAvailable(record, ctx.signal); return operation(record, ctx); });
    record.tail = run.catch(() => {});
    return run.finally(() => { record.pending--; joined.dispose(); });
  }
  status(input, ctx = {}) { return this.enqueue(input.phoneSessionId, input, ctx, async (record, context) => { const proof = await this.validate(record, context); const result = await this.sdk(record, 'status', { sessionId: record.backendId }, context); return this.public(record, { ...result, identity: record.identity, crossChannelMapping: proof.crossChannelMapping }); }); }
  endpoint(input, ctx = {}) { return this.enqueue(input.phoneSessionId, input, ctx, async (record, context) => { await this.validate(record, context); return this.public(record, await this.sdk(record, 'endpoint', { sessionId: record.backendId }, context)); }); }
  input(input, ctx = {}) { return this.enqueue(input.phoneSessionId, input, ctx, async (record, context) => {
    check(['tap', 'swipe', 'text', 'key', 'button'].includes(input.action), 'PHONE_UNKNOWN_OPERATION', 'Unsupported phone input action.');
    await this.validate(record, context);
    const allowed = ['x', 'y', 'toX', 'toY', 'durationMs', 'text', 'keys', 'mode', 'button'];
    const args = Object.fromEntries(allowed.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    try { return this.public(record, await this.sdk(record, input.action, { ...args, sessionId: record.backendId }, context)); }
    catch (error) { throw errorWithDetails(error, { operationMayContinue: error.operationMayContinue ?? !beforeDispatchCodes.has(error.code) }); }
  }); }
  screenshot(input, ctx = {}) { return this.enqueue(input.phoneSessionId, input, ctx, async (record, context) => {
    await this.validate(record, context);
    const output = input.path ? path.resolve(input.path) : path.join(os.tmpdir(), 'vs2015-mcp-captures', randomUUID() + '.png');
    await mkdir(path.dirname(output), { recursive: true }); this.assertAvailable(record, context.signal);
    return this.public(record, await this.sdk(record, 'capture', { sessionId: record.backendId, path: output }, context));
  }); }
  portal(input, ctx = {}) { return this.enqueue(input.phoneSessionId, input, ctx, async (record, context) => {
    check(record.input.coreConDeviceId, 'PORTAL_BINDING_REQUIRED', 'Open the phone session with an exact CoreCon device and locale.');
    const proof = await this.validate(record, context, { skipIde: ['stop', 'download'].includes(input.action) });
    if (input.action === 'connect') {
      check(!record.portal, 'PORTAL_ALREADY_CONNECTED', 'This phone session already has a Portal connection. Close the phone session before changing the endpoint.');
      record.portal = await PortalSession.connect(input, proof.crossChannelMapping, record.identity, context);
      try { this.assertAvailable(record, context.signal); }
      catch (error) { record.portal.close(); throw error; }
      return this.public(record, record.portal.public());
    }
    check(record.portal, 'PORTAL_NOT_CONNECTED', 'Connect Device Portal for this phone session first.');
    await record.portal.validate(proof.crossChannelMapping, context);
    this.assertAvailable(record, context.signal);
    return this.public(record, await record.portal.execute(input, context));
  }); }
  guestWpr(input, ctx = {}) { return this.enqueue(input.phoneSessionId, input, ctx, async (record, context) => {
    const operations = { status: 'guestWprStatus', start: 'guestWprStart', stop: 'guestWprStop' };
    const operation = operations[input.action];
    check(operation, 'GUEST_WPR_INVALID_ACTION', 'Select status, start or stop.');
    check(record.input.coreConDeviceId, 'GUEST_WPR_BINDING_REQUIRED', 'Open the phone session with an exact CoreCon device and locale.');
    // Stopping an owned capture remains possible after project edits or IDE exit.
    // The original SDK controller still checks the VM and both endpoint addresses.
    if (input.action !== 'stop') await this.validate(record, context);
    if (!record.wprRunId) {
      check(input.action === 'status', 'GUEST_WPR_STATUS_REQUIRED', 'Observe WPR status before starting a capture.');
      const run = input.runId ? await readRun(input.runId) : await createRun({ operation: 'phone:guest-wpr', context: { target: record.identity, ideBinding: record.snapshot ?? null } });
      record.wprRunId = run.id;
    }
    check(!input.runId || input.runId === record.wprRunId, 'GUEST_WPR_HISTORY_CONFLICT', 'This phone session already has a WPR history run.');
    const args = { sessionId: record.backendId };
    if (input.action === 'status') args.artifactRoot = path.join(runDirectory(record.wprRunId), 'guest-wpr', record.id);
    if (input.action === 'start') Object.assign(args, { profiles: input.profiles, exclusiveGuest: input.exclusiveGuest,
      allowUnknownStatus: input.allowUnknownStatus, observedStatusFingerprint: input.observedStatusFingerprint,
      metadata: { operation: input.operation, ideBinding: record.snapshot ?? null } });
    if (input.action === 'stop') Object.assign(args, { captureId: input.captureId, exclusiveGuest: input.exclusiveGuest });
    await appendEvent(record.wprRunId, { kind: 'guestWprRequested', action: input.action, phoneSessionId: record.id });
    let result;
    try { result = await this.sdk(record, operation, args, context); }
    catch (error) {
      result = { error: { code: error.code ?? 'GUEST_WPR_FAILED', message: error.message,
        operationMayContinue: error.operationMayContinue ?? error.backendError?.operationMayContinue ?? false,
        details: error.details ?? error.backendError?.details } };
    }
    let artifact;
    try { artifact = await saveArtifact(record.wprRunId, 'guest-wpr', { action: input.action, result }); }
    catch (error) {
      fail('GUEST_WPR_HISTORY_FAILED', 'The WPR operation returned, but its history artifact could not be saved. Inspect the returned result and durable receipt.',
        { operationMayContinue: input.action !== 'status', details: { runId: record.wprRunId, result, cause: error.message } });
    }
    return { ...this.public(record, result), runId: record.wprRunId, artifactId: artifact.artifactId, artifactPath: artifact.path };
  }); }
  ide(input, ctx = {}) {
    const inheritedTimeout = input.timeoutMs ?? (
      input.toolName === 'vs2015_ide_debug_control' && input.arguments?.action === 'go' ? 120000
      : input.toolName === 'vs2015_ide_xaml_tree' ? Math.max(25000, Number(input.arguments?.queryTimeoutMs ?? 15000) + 10000)
      : 15000
    );
    return this.enqueue(input.phoneSessionId, { ...input, timeoutMs: inheritedTimeout }, ctx, async (record, context) => {
    check(record.binding, 'PHONE_IDE_BINDING_REQUIRED', 'This phone session has no IDE binding.');
    const definition = this.ideDefinitions.get(input.toolName);
    check(this.ideToolAllowlist.has(input.toolName) && definition, 'PHONE_IDE_TOOL_FORBIDDEN', 'The selected IDE tool is not permitted through a bound phone session.');
    const args = input.arguments ?? {};
    check(!own(args, 'sessionId') || args.sessionId === record.binding.sessionId, 'PHONE_IDE_SESSION_CONFLICT', 'Caller arguments cannot select another IDE session.');
    if (own(args, 'projectUniqueName')) check(samePath(args.projectUniqueName, record.binding.projectUniqueName), 'PHONE_IDE_PROJECT_CONFLICT', 'Caller arguments cannot select another project.');
    const isPhoneGo = input.toolName === 'vs2015_ide_debug_control' && args.action === 'go';
    check(!own(args, 'expectedPhoneBinding') || isPhoneGo, 'PHONE_IDE_GUARD_UNEXPECTED', 'expectedPhoneBinding is generated by this session only for Go.');
    // Validate caller arguments before any backend work; parse the complete
    // server-bound request again immediately before dispatch.
    definition.schema.parse({ timeoutMs: inheritedTimeout, ...args, sessionId: record.binding.sessionId });
    await this.validate(record, context); this.assertAvailable(record, context.signal);
    const forwarded = { timeoutMs: inheritedTimeout, ...args, sessionId: record.binding.sessionId };
    let expectedPhoneBinding;
    if (isPhoneGo) {
      expectedPhoneBinding = { configurationToken: record.snapshot.configurationToken, projectUniqueName: record.snapshot.projectUniqueName,
        targetPropertyName: record.binding.targetPropertyName, scope: record.binding.scope, deviceId: record.input.coreConDeviceId,
        manifestPath: record.snapshot.manifestPath, manifestSha256: record.snapshot.manifestSha256, applicationId: record.snapshot.applicationId,
        targetGuards: structuredClone(record.guards ?? []) };
      check(!own(args, 'expectedPhoneBinding') || isDeepStrictEqual(args.expectedPhoneBinding, expectedPhoneBinding),
        'PHONE_IDE_GUARD_CONFLICT', 'Caller expectedPhoneBinding cannot override the actual bound phone/project guard.');
      forwarded.expectedPhoneBinding = expectedPhoneBinding;
    }
    const parsed = definition.schema.parse(forwarded);
    if (isPhoneGo) check(isDeepStrictEqual(parsed.expectedPhoneBinding, expectedPhoneBinding), 'PHONE_IDE_GUARD_UNSUPPORTED',
      'The registered IDE Go schema did not preserve the complete phone preflight guard. Update the IDE tool/bridge before dispatching Go.');
    const result = checkedResult(await definition.run(parsed, context));
    const verification = input.toolName === 'vs2015_ide_guest_app_identity'
      ? verifyGuestApplication(record.snapshot, result) : { applicationVerification: 'project-only' };
    return { ...result, phoneSessionId: record.id, ...verification, toolName: input.toolName };
  }); }
  close(input) {
    const record = this.get(input.phoneSessionId); if (record.closePromise) return record.closePromise;
    record.closing = true;
    record.closePromise = record.tail.then(async () => {
      let result, shutdown, error;
      try {
        if (record.controllerPinned && (record.client.child !== record.controllerToken || record.client.ready !== true)) record.transportInvalid = true;
        if (!record.transportInvalid && record.backendId) result = await record.client.request('close', { sessionId: record.backendId }, { timeoutMs: input.timeoutMs ?? 15000 }); }
      catch (failure) { error = errorWithDetails(failure); }
      finally { try { shutdown = await record.client?.stop(); } catch (failure) { shutdown = { cleanupStatus: 'unknown', error: failure.message }; } this.records.delete(record.id); record.state = 'closed'; }
      const { sessionId: ignored, ...closedResult } = result ?? {};
      const cleanupWarnings = [...(result?.cleanupWarnings ?? []), ...(record.portal?.close() ?? [])];
      return { ...closedResult, phoneSessionId: record.id, closed: true, vmClosed: false,
        cleanupWarnings,
        cleanupStatus: cleanupWarnings.length ? 'unknown' : result ? (result.unreleasedKeys?.length ? 'unknown' : 'completed') : shutdown?.cleanupStatus ?? 'unknown',
        cleanupDetails: { shutdown }, ...(error ? { error: { code: error.code, message: error.message, operationMayContinue: error.operationMayContinue } } : {}) };
    });
    return record.closePromise;
  }
  async stopAll() {
    this.closed = true; const records = [...this.records.values()]; this.records.clear();
    for (const record of records) { record.state = 'stopped'; record.closing = true; record.stopController.abort(new PhoneSessionError('PHONE_SESSION_CLOSED', 'The MCP connection closed.')); }
    return Promise.allSettled(records.map(async record => ({ phoneSessionId: record.id,
      cleanupWarnings: record.portal?.close() ?? [], shutdown: await record.client?.stop() })));
  }
}


import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhoneSessionManager } from '../src/phone-session-manager.mjs';
import { createPhoneSessionDefinitions } from '../src/phone-session.mjs';
import { createRun, readArtifact } from '../src/history.mjs';

const product = fileURLToPath(new URL('../', import.meta.url));
const vmId = '10000000-0000-4000-8000-000000000001';
const deviceId = '20000000-0000-4000-8000-000000000001';
const captureId = '30000000-0000-4000-8000-000000000001';
const startTimeUtc = '2026-11-19T01:02:03.1234567Z';

test('guest WPR schemas require explicit ownership and typed capture parameters', () => {
  const definitions = createPhoneSessionDefinitions({});
  const start = definitions.find(tool => tool.name === 'phone_session_wpr_start').schema;
  const input = { phoneSessionId: vmId, exclusiveGuest: true, operation: 'UI interaction', observedStatusFingerprint: 'a'.repeat(64) };
  assert.equal(start.parse(input).allowUnknownStatus, false);
  assert.deepEqual(start.parse(input).profiles, ['cpu']);
  assert.throws(() => start.parse({ ...input, exclusiveGuest: false }));
  assert.throws(() => start.parse({ ...input, profiles: ['cpu -cancel'] }));
  assert.throws(() => start.parse({ ...input, command: '-cancel' }));
  assert.throws(() => definitions.find(tool => tool.name === 'phone_session_wpr_stop').schema.parse({ phoneSessionId: vmId, exclusiveGuest: true }));
});

test('guest WPR history preserves uncertain dispatch and binds artifacts to the original controller', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guest-wpr-history-'));
  const previous = process.env.VS2015_MCP_HISTORY;
  process.env.VS2015_MCP_HISTORY = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.VS2015_MCP_HISTORY;
    else process.env.VS2015_MCP_HISTORY = previous;
    await rm(root, { recursive: true, force: true });
  });
  const identity = { processId: 81, startTimeUtc, vmId, vmName: 'Fixture', executable: 'C:\\XDE\\8.1\\XDE.exe', directory: 'C:\\XDE\\8.1' };
  const mapping = { matched: true, method: 'sdk-endpoint-pair', deviceId, localeId: 1033, vmId, processId: 81, hostAddress: '169.254.1.1', guestAddress: '169.254.1.2' };
  const calls = [];
  const manager = new PhoneSessionManager({ clientFactory: () => ({
    async request(operation, args) {
      calls.push({ operation, args });
      if (operation === 'open' || operation === 'identity') return { sessionId: 'backend', identity, crossChannelMapping: mapping };
      if (operation === 'guestWprStatus') return { observation: { status: { state: 'unknown', fingerprint: 'a'.repeat(64) } } };
      if (operation === 'guestWprStart') throw Object.assign(new Error('Start may have executed'), {
        code: 'GUEST_WPR_START_UNCONFIRMED', operationMayContinue: true,
        backendError: { details: { capture: { captureId, receiptPath: path.join(root, 'capture.json') } } },
      });
      if (operation === 'guestWprStop') return { captureId, state: 'stopped-artifact-verified', trace: { headerPlausible: true, eventContentValidated: false } };
      if (operation === 'close') return { closed: true, cleanupWarnings: [], unreleasedKeys: [] };
      throw new Error(operation);
    },
    async stop() { return { cleanupStatus: 'completed' }; },
  }) });
  t.after(() => manager.stopAll());
  const opened = await manager.open({ processId: 81, expectedStartTimeUtc: startTimeUtc, expectedVmId: vmId, coreConDeviceId: deviceId, localeId: 1033 });
  const session = { phoneSessionId: opened.phoneSessionId, timeoutMs: 240000 };
  await assert.rejects(manager.guestWpr({ ...session, action: 'start' }), { code: 'GUEST_WPR_STATUS_REQUIRED' });
  const observed = await manager.guestWpr({ ...session, action: 'status' });
  const otherRun = await createRun({ operation: 'unrelated' });
  await assert.rejects(manager.guestWpr({ ...session, action: 'status', runId: otherRun.id }), { code: 'GUEST_WPR_HISTORY_CONFLICT' });
  const started = await manager.guestWpr({ ...session, action: 'start', operation: 'tap', profiles: ['cpu'], exclusiveGuest: true, allowUnknownStatus: true, observedStatusFingerprint: 'a'.repeat(64) });
  assert.equal(started.error.operationMayContinue, true);
  assert.equal(started.error.details.capture.captureId, captureId);
  assert.equal(started.runId, observed.runId);
  const saved = await readArtifact(started.runId, started.artifactId);
  assert.deepEqual(saved.data.result.error, started.error);
  assert.equal(calls.filter(call => call.operation === 'guestWprStart').length, 1);
  assert.equal(calls.find(call => call.operation === 'guestWprStart').args.sessionId, 'backend');
  const stopped = await manager.guestWpr({ ...session, action: 'stop', captureId, exclusiveGuest: true });
  assert.equal(stopped.trace.eventContentValidated, false);
  assert.equal(stopped.runId, observed.runId);
  await manager.close(session);
});

test('guest WPR native lifecycle rejects foreign captures, uncertain replay and invalid ETL', { skip: process.platform !== 'win32' }, async () => {
  const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(windows);
  const root = await mkdtemp(path.join(os.tmpdir(), 'guest-wpr-native-'));
  const result = spawnSync(path.join(windows, 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(product, 'test/fixtures/Test-GuestWpr.ps1'),
    '-ScriptsDirectory', path.join(product, 'scripts'), '-OutputRoot', root,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.passed, 10);
  assert.equal(outcome.liveGuestUsed, false);
  assert.equal(path.resolve(outcome.artifactRoot), path.resolve(root));
  await rm(root, { recursive: true, force: true });
});

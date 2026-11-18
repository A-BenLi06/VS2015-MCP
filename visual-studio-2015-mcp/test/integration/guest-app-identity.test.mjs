import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { IdeBridgeClient } from '../../src/ide-client.mjs';

const product = process.env.VS2015_TEST_PRODUCT_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const fixturePath = process.env.VS2015_TEST_GUEST_IDENTITY_CONTEXT;
const enabled = process.platform === 'win32' && fixturePath;

function run(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Guest-identity test helper timeout')); }, 90000);
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code ? reject(new Error(stdout + ' ' + stderr)) : resolve(stdout); });
    child.stdin.end(input);
  });
}

async function build() {
  const value = JSON.parse(await run(process.env.VS2015_MCP_PWSH ?? 'pwsh.exe', ['-NoProfile', '-File', path.join(product, 'scripts/Build-IdeBridge.ps1')], '{}'));
  assert.ok(value.executablePath, value.error?.message);
  return value;
}

test('fixed guest identity payload and shared debugger literals reject fabricated or partial values', { skip: !enabled, timeout: 180000 }, async () => {
  const built = await build();
  const root = await mkdtemp(path.join(os.tmpdir(), 'v15-guest-identity-parser-'));
  const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows';
  try {
    const executable = path.join(root, 'GuestIdentityTests.exe');
    await run(path.join(windows, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'), ['/nologo', '/utf8output', '/platform:x86', '/reference:System.Web.Extensions.dll', '/out:' + executable, path.join(product, 'test/fixtures/GuestIdentityTests.cs')]);
    const value = JSON.parse(await run(executable, [built.executablePath]));
    assert.equal(value.passed, true);
    assert.equal(value.checks, 22);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('owned paused guest identity requires current pause/frame and returns actual SDK fields', { skip: !enabled, timeout: 180000 }, async () => {
  const relative = path.relative(os.tmpdir(), path.resolve(fixturePath));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.equal(fixture.ownsIde, true);
  assert.ok(fixture.expectedGuestIdentity);
  const built = await build();
  const client = new IdeBridgeClient({ launch: () => spawn(built.executablePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) });
  let sessionId;
  const call = (operation, input = {}) => client.request(operation, { sessionId, ...input }, { timeoutMs: 60000 });
  try {
    sessionId = (await call('attach', { processId: fixture.processId, expectedStartTimeUtc: fixture.startTimeUtc })).sessionId;
    const state = await call('debugState');
    assert.equal(state.mode, 'break');
    assert.equal(state.currentFrame.sourceFile.toLowerCase(), fixture.source.toLowerCase());
    await assert.rejects(call('guestDebugAppIdentity', { pauseId: '00000000-0000-0000-0000-000000000000', frameId: state.currentFrame.frameId }), { code: 'STALE_DEBUG_CONTEXT' });
    await assert.rejects(call('guestDebugAppIdentity', { pauseId: state.pauseId, frameId: '00000000-0000-0000-0000-000000000000' }), { code: 'DEBUG_CONTEXT_CHANGED' });
    const observed = await call('guestDebugAppIdentity', { pauseId: state.pauseId, frameId: state.currentFrame.frameId, includeProductId: true, expressionTimeoutMs: 10000 });
    assert.equal(observed.confirmed, true, JSON.stringify(observed));
    assert.equal(observed.status, 'observed');
    assert.deepEqual(observed.applicationIdentity, fixture.expectedGuestIdentity);
    assert.ok(observed.transport.transportId && observed.transport.programIdentityKey);
    assert.equal(observed.sourceContext.sourceFile.toLowerCase(), fixture.source.toLowerCase());
    assert.equal(typeof observed.rawProductId.available, 'boolean');
    if (!observed.rawProductId.available) assert.ok(observed.rawProductId.unavailableReason);
  } finally {
    if (sessionId) await call('detach').catch(() => {});
    await client.stop();
  }
});

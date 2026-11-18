import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PhoneBridgeClient, createPhoneBridgeLauncher } from '../../src/phone-client.mjs';

const manifestPath = process.env.VS2015_TEST_PHONE_SESSION_MANIFEST;
test('owned XDE persistent session identity, capture replacement and graceful key lifecycle', {
  skip: process.platform !== 'win32' || !manifestPath, timeout: 120000,
}, async t => {
  const relative = path.relative(os.tmpdir(), path.resolve(manifestPath));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'The explicit fixture manifest must be inside TEMP.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.ownsXde, true, 'The test must own its XDE fixture.');
  assert.ok(Number.isInteger(manifest.processId) && manifest.processId > 0);
  assert.match(manifest.vmId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.ok(Number.isFinite(Date.parse(manifest.startTimeUtc)));
  const identity = { processId: manifest.processId, expectedStartTimeUtc: manifest.startTimeUtc, expectedVmId: manifest.vmId };
  if (manifest.coreConDeviceId || manifest.localeId) {
    assert.match(manifest.coreConDeviceId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    assert.ok(Number.isInteger(manifest.localeId) && manifest.localeId > 0);
    Object.assign(identity, { coreConDeviceId: manifest.coreConDeviceId, localeId: manifest.localeId });
  }
  const scriptPath = process.env.VS2015_TEST_PHONE_BRIDGE_SCRIPT ?? fileURLToPath(new URL('../../scripts/PhoneSessionBridge.ps1', import.meta.url));
  const make = () => new PhoneBridgeClient({ launch: createPhoneBridgeLauncher({ scriptPath }) });
  const client = make(); let sessionId;
  const observe = async (target, label, operation, input, timeoutMs = operation === 'open' ? 60000 : 20000) => {
    const started = Date.now();
    try { const value = await target.request(operation, input, { timeoutMs }); t.diagnostic(`${label}/${operation}: ${Date.now() - started}ms`); return value; }
    catch (error) { error.message = `${label}/${operation}: ${error.message}`; throw error; }
  };
  const call = (operation, input = {}) => observe(client, 'primary', operation, { sessionId, ...input });
  try {
    await assert.rejects(call('open', { ...identity, expectedStartTimeUtc: '2000-01-01T00:00:00.0000000Z' }), { code: 'PHONE_TARGET_CHANGED' });
    await assert.rejects(call('open', { ...identity, expectedVmId: '00000000-0000-0000-0000-000000000000' }), { code: 'PHONE_TARGET_CHANGED' });
    let opened = await call('open', identity); sessionId = opened.sessionId;
    assert.equal(opened.identity.vmId.toLowerCase(), manifest.vmId.toLowerCase());
    assert.equal(opened.inputClientCreated, false);
    if (identity.coreConDeviceId) assert.equal(opened.crossChannelMapping.matched, true);
    const competitor = make();
    try { await assert.rejects(observe(competitor, 'competing', 'open', identity), { code: 'PHONE_SESSION_BUSY' }); }
    finally { await competitor.stop(); }
    const status = await call('status'); assert.equal(status.shellReady, true);
    const endpoint = await call('endpoint'); assert.ok(endpoint.hostAddress && endpoint.guestAddress);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-phone-session-capture-'));
    const output = path.join(directory, 'guest.png');
    const first = await call('capture', { path: output });
    const replaced = await call('capture', { path: output });
    assert.equal(first.width, replaced.width); assert.equal(first.height, replaced.height);
    assert.ok(replaced.bytes > 8); assert.equal((await readFile(output)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal((await call('close')).vmClosed, false); sessionId = undefined;
    opened = await call('open', identity); sessionId = opened.sessionId;
    assert.equal((await call('identity')).inputClientCreated, false);
    if (process.env.VS2015_TEST_PHONE_INPUT === '1') {
      await call('key', { keys: ['ControlKey'], mode: 'Press' });
      const held = await call('identity'); assert.equal(held.inputClientCreated, true); assert.deepEqual(held.heldKeys, ['ControlKey']);
      await call('key', { keys: ['ControlKey'], mode: 'Release' });
      assert.deepEqual((await call('identity')).heldKeys, []);
      assert.deepEqual((await call('close')).unreleasedKeys, []); sessionId = undefined;
      sessionId = (await call('open', identity)).sessionId;
      await call('key', { keys: ['ShiftKey'], mode: 'Press' });
      assert.deepEqual((await call('identity')).heldKeys, ['ShiftKey']);
      // stdin EOF exercises the actual PS finally cleanup with the same input client.
      const stopped = await client.stop(); sessionId = undefined;
      assert.equal(stopped.forcedTermination, false); assert.equal(stopped.cleanupStatus, 'completed'); assert.equal(stopped.stderr, '');
    } else {
      assert.deepEqual((await call('close')).unreleasedKeys, []); sessionId = undefined;
    }
  } finally {
    if (sessionId) await call('close').catch(() => {});
    await client.stop();
  }
  // A new controller can still observe the same VM/PID/start after EOF; no VM Close.
  const verify = make();
  try {
    const reopened = await observe(verify, 'verification', 'open', identity);
    assert.equal(reopened.identity.processId, manifest.processId);
    assert.equal((await observe(verify, 'verification', 'status', { sessionId: reopened.sessionId })).shellReady, true);
    assert.equal((await observe(verify, 'verification', 'close', { sessionId: reopened.sessionId })).vmClosed, false);
  } finally { await verify.stop(); }
});

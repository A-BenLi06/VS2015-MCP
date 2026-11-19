import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { utcIdentityTicks } from '../../src/phone-session-manager.mjs';

const contextFile = process.env.VS2015_TEST_WP81_WPR_CONTEXT;
test('owned WP8.1 public WPR capture downloads a trace and persists the same evidence', {
  skip: process.platform !== 'win32' || !contextFile, timeout: 600000,
}, async t => {
  const relative = path.relative(os.tmpdir(), path.resolve(contextFile));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const context = JSON.parse(await readFile(contextFile, 'utf8'));
  assert.equal(context.ownsXde, true);
  assert.equal(context.exclusiveGuest, true);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wpr-runtime-'));
  const records = [];
  const client = new Client({ name: 'guest-wpr-runtime', version: '1' });
  const product = fileURLToPath(new URL('../../', import.meta.url));
  let phoneSessionId;
  let activeCaptureId;
  let cleaning = false;
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }, { timeout: 300000, ...(cleaning ? {} : { signal: t.signal }) });
    records.push({ name, args, result: response.structuredContent, isError: response.isError });
    await writeFile(path.join(directory, 'results.json'), JSON.stringify(records, null, 2));
    assert.equal(response.isError, false, JSON.stringify(response.structuredContent));
    return response.structuredContent;
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(product, 'src/server.mjs')], cwd: product }));
    const discovered = await call('phone_discover', {});
    const phone = discovered.running.find(item => item.processId === context.processId);
    assert.ok(phone);
    assert.equal(utcIdentityTicks(phone.startTimeUtc), utcIdentityTicks(context.startTimeUtc));
    assert.equal(phone.vmId.toLowerCase(), context.vmId.toLowerCase());
    phoneSessionId = (await call('phone_session_open', {
      processId: context.processId, expectedStartTimeUtc: context.startTimeUtc, expectedVmId: context.vmId,
      coreConDeviceId: context.coreConDeviceId, localeId: context.localeId, timeoutMs: 120000,
    })).phoneSessionId;
    const observed = await call('phone_session_wpr_status', { phoneSessionId });
    assert.notEqual(observed.observation.status.state, 'recording');
    const capture = await call('phone_session_wpr_start', {
      phoneSessionId, operation: 'Owned WP8.1 WPR runtime validation', exclusiveGuest: true,
      observedStatusFingerprint: observed.observation.status.fingerprint, allowUnknownStatus: context.allowUnknownStatus === true,
    });
    activeCaptureId = capture.captureId;
    assert.equal(capture.state, 'recording');
    assert.deepEqual(capture.profileIds, ['CPU.Verbose.Memory']);
    await new Promise(resolve => setTimeout(resolve, 5000));
    // Retire the test's cleanup intent before dispatch so a failed Stop is not replayed.
    activeCaptureId = null;
    const stopped = await call('phone_session_wpr_stop', { phoneSessionId, captureId: capture.captureId, exclusiveGuest: true });
    assert.equal(stopped.state, 'stopped-artifact-verified');
    const trace = await readFile(stopped.trace.path);
    assert.equal(trace.length, stopped.trace.bytes);
    assert.equal(createHash('sha256').update(trace).digest('hex'), stopped.trace.sha256);
    assert.equal(stopped.trace.headerPlausible, true);
    assert.equal(stopped.trace.eventContentValidated, false);
    const artifact = await call('vs2015_history_artifact', { runId: stopped.runId, artifactId: stopped.artifactId });
    assert.deepEqual(artifact.data.result.trace, stopped.trace);
    assert.equal(stopped.runId, capture.runId);
    t.diagnostic(`Capture evidence ${stopped.receiptPath}; protocol ${directory}`);
  } finally {
    cleaning = true;
    try {
      if (activeCaptureId) await call('phone_session_wpr_stop', { phoneSessionId, captureId: activeCaptureId, exclusiveGuest: true });
    } finally {
      try {
        if (phoneSessionId) {
          const closed = await call('phone_session_close', { phoneSessionId });
          assert.equal(closed.cleanupStatus, 'completed');
          assert.deepEqual(closed.cleanupWarnings, []);
        }
      } finally { await client.close(); }
    }
  }
});

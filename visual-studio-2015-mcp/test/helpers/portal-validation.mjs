import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export function credentialEnvironment(context) {
  const env = {};
  for (const name of [context.usernameEnv, context.passwordEnv, context.pairingPinEnv].filter(Boolean)) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
    assert.notEqual(process.env[name], undefined, 'A configured Portal credential variable is missing.');
    env[name] = process.env[name];
  }
  return env;
}

export async function validateMobilePortal(contextPath, { signal, selectProfile, onDirectory } = {}) {
  const relative = path.relative(os.tmpdir(), path.resolve(contextPath));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.equal(context.ownsXde, true); assert.equal(context.exclusiveGuest, true);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portal-runtime-'));
  onDirectory?.(directory);
  const records = []; let phoneSessionId, ownedCapture, cleaning = false;
  const client = new Client({ name: 'portal-runtime-test', version: '1' });
  const product = fileURLToPath(new URL('../../', import.meta.url));
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }, { timeout: 300000, ...(cleaning ? {} : { signal }) });
    records.push({ name, args, result: response.structuredContent, isError: response.isError });
    await writeFile(path.join(directory, 'results.json'), JSON.stringify(records, null, 2));
    if (name === 'phone_session_portal_wpr_start' && response.structuredContent?.error?.details?.capture)
      ownedCapture = response.structuredContent.error.details.capture.captureId;
    assert.equal(response.isError, false, JSON.stringify(response.structuredContent)); return response.structuredContent;
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(product, 'src/server.mjs')], cwd: product, env: credentialEnvironment(context) }));
    phoneSessionId = (await call('phone_session_open', { processId: context.processId, expectedStartTimeUtc: context.startTimeUtc,
      expectedVmId: context.vmId, coreConDeviceId: context.coreConDeviceId, localeId: context.localeId, timeoutMs: 120000 })).phoneSessionId;
    const connected = await call('phone_session_portal_connect', { phoneSessionId, baseUrl: context.baseUrl, timeoutMs: 60000,
      allowInsecureHttp: context.allowInsecureHttp === true, usernameEnv: context.usernameEnv, passwordEnv: context.passwordEnv, pairingPinEnv: context.pairingPinEnv, caPath: context.caPath, certificateSha256: context.certificateSha256 });
    assert.ok(connected.osInfo.OsVersion);
    for (const resource of ['processes', 'systemPerformance', 'packages']) {
      const read = await call('phone_session_portal_read', { phoneSessionId, resource }); assert.ok(read.data);
      if (resource === 'systemPerformance') { assert.ok(Number.isFinite(read.data.CpuLoad)); assert.ok(read.data.PageSize > 0); }
      assert.equal(read.runId, connected.runId);
    }
    const observed = await call('phone_session_portal_wpr_status', { phoneSessionId }); assert.equal(observed.status.state, 'idle');
    const profilePointer = context.profilePointer ?? await selectProfile?.(observed.profiles);
    assert.ok(profilePointer, 'Choose a profilePointer from the observed catalog.');
    const started = await call('phone_session_portal_wpr_start', { phoneSessionId, operation: 'Owned Mobile Portal validation', exclusiveGuest: true,
      profilePointer, observedStatusFingerprint: observed.status.fingerprint, profilesFingerprint: observed.profilesFingerprint });
    ownedCapture = started.captureId; assert.equal(started.state, 'recording');
    await new Promise(resolve => setTimeout(resolve, 5000));
    ownedCapture = null; // A failed dispatched stop must never be replayed by cleanup.
    const stopped = await call('phone_session_portal_wpr_stop', { phoneSessionId, captureId: started.captureId, exclusiveGuest: true });
    const completed = stopped.trace ? stopped : await call('phone_session_portal_wpr_download', { phoneSessionId, captureId: started.captureId });
    const trace = await readFile(completed.trace.path);
    assert.equal(trace.length, completed.trace.bytes); assert.equal(createHash('sha256').update(trace).digest('hex'), completed.trace.sha256);
    const artifact = await call('vs2015_history_artifact', { runId: completed.runId, artifactId: completed.artifactId });
    assert.deepEqual(artifact.data.result.trace, completed.trace);
    assert.equal((await call('phone_session_portal_wpr_status', { phoneSessionId })).status.state, 'idle');
    return { receiptPath: completed.receiptPath, directory, trace: completed.trace, runId: completed.runId };
  } finally {
    cleaning = true;
    try { if (ownedCapture) await call('phone_session_portal_wpr_stop', { phoneSessionId, captureId: ownedCapture, exclusiveGuest: true }); }
    finally {
      try { if (phoneSessionId) { const closed = await call('phone_session_close', { phoneSessionId }); assert.deepEqual(closed.cleanupWarnings, []); } }
      finally { await client.close(); }
    }
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PortalSession } from '../src/portal-session.mjs';
import { readArtifact } from '../src/history.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-session-'));
  const previous = process.env.VS2015_MCP_HISTORY; process.env.VS2015_MCP_HISTORY = root;
  const state = { running: false, files: [], calls: [], profiles: { localized: [{ label: '处理器', id: 'CPU.Verbose' }] }, os: { ComputerName: 'Phone', OsVersion: '10.0.14393', Platform: 'Phone' } };
  const etl = Buffer.alloc(4096); etl.writeUInt32LE(4096, 0); etl.writeUInt32LE(512, 4);
  const server = http.createServer((q, r) => {
    const url = new URL(q.url, 'http://fixture'); const route = url.pathname;
    state.calls.push([q.method, q.url]); r.setHeader('Content-Type', 'application/json');
    const json = v => r.end(JSON.stringify(v));
    if (route === '/api/os/info') return json(state.os);
    if (route === '/api/wpr/status') return json({ State: state.unknown ? '?' : state.running ? 'Running' : 'Idle', SessionType: 'normal' });
    if (route === '/perfprofiles/profiles.json') return json(state.profiles);
    if (route === '/api/wpr/tracefiles') return json({ Items: state.files });
    if (route === '/api/wpr/trace' && q.method === 'POST') {
      state.running = true; state.profile = url.searchParams.get('profile');
      if (state.loseStart) return q.socket.destroy();
      return json({ State: 'Running', SessionType: 'normal' });
    }
    if (route === '/api/wpr/trace') {
      state.running = false; state.files.push({ Name: 'guest trace.etl', Id: '1', DateCreated: 1234, FileSize: etl.length });
      if (state.loseStop) return q.socket.destroy();
      if (state.direct) { r.setHeader('Content-Type', 'application/octet-stream'); return r.end(etl); }
      return r.end();
    }
    if (route === '/api/wpr/tracefile') {
      if (state.failDownload) { r.statusCode = 500; return r.end(); }
      r.setHeader('Content-Type', 'application/octet-stream'); return r.end(etl);
    }
    if (route === '/api/resourcemanager/processes') return json({ Processes: [{ ProcessId: 12, ImageName: 'app.exe' }] });
    r.statusCode = 404; r.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proof = { matched: true, vmId: '10000000-0000-4000-8000-000000000001', guestAddress: '127.0.0.1' };
  const session = await PortalSession.connect({ baseUrl: `http://127.0.0.1:${server.address().port}`, allowInsecureHttp: true }, proof, { vmId: proof.vmId }, {});
  t.after(async () => {
    session.close(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    if (previous === undefined) delete process.env.VS2015_MCP_HISTORY; else process.env.VS2015_MCP_HISTORY = previous;
    await rm(root, { recursive: true, force: true });
  });
  const startArgs = async () => { const observed = await session.status({}); return { exclusiveGuest: true, operation: 'fixture action', observedStatusFingerprint: observed.status.fingerprint,
    profilesFingerprint: observed.profilesFingerprint, profilePointer: '/localized/0/id' }; };
  return { state, session, proof, startArgs, etl };
}
test('Portal capture lifecycle uses observed catalog, persists receipts and retries only downloads', async t => {
  const f = await fixture(t); await f.session.validate(f.proof, {});
  const started = await f.session.execute({ action: 'start', ...await f.startArgs() }, {});
  assert.equal(started.state, 'recording'); assert.equal(f.state.profile, 'CPU.Verbose');
  const args = { captureId: started.captureId, exclusiveGuest: true };
  const stopped = await f.session.execute({ action: 'stop', ...args }, {}); assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.operationMayContinue, false); assert.equal(stopped.candidateFiles.length, 1);
  f.state.failDownload = true;
  assert.equal((await f.session.execute({ action: 'download', ...args }, {})).error.code, 'PORTAL_HTTP_ERROR');
  f.state.failDownload = false;
  const downloaded = await f.session.execute({ action: 'download', ...args }, {});
  assert.equal(downloaded.state, 'stopped-artifact-verified'); assert.deepEqual(await readFile(downloaded.trace.path), f.etl);
  assert.equal(downloaded.trace.eventContentValidated, false);
  assert.deepEqual((await readArtifact(downloaded.runId, downloaded.artifactId)).data.result.trace, downloaded.trace);
  assert.equal((await f.session.execute({ action: 'stop', ...args }, {})).error.code, 'PORTAL_STOP_REPLAY_REFUSED');
  assert.equal(f.state.calls.filter(([method, url]) => method === 'GET' && url === '/api/wpr/trace').length, 1);
  assert.deepEqual(f.session.close(), []);
});
test('Portal blocks existing/unknown recordings and changed profile observations before dispatch', async t => {
  const f = await fixture(t); const input = await f.startArgs();
  f.state.running = true; await assert.rejects(f.session.start(input, {}), { code: 'PORTAL_WPR_NOT_IDLE' });
  f.state.running = false; f.state.unknown = true; await assert.rejects(f.session.start(input, {}), { code: 'PORTAL_WPR_NOT_IDLE' });
  f.state.unknown = false; f.state.profiles.localized[0].id = 'Changed';
  await assert.rejects(f.session.start(input, {}), { code: 'PORTAL_OBSERVATION_CHANGED' });
  await assert.rejects(f.session.start({ ...await f.startArgs(), profilePointer: '/missing' }, {}), { code: 'PORTAL_PROFILE_INVALID' });
  assert.equal(f.state.calls.some(([method]) => method === 'POST'), false);
});
test('uncertain start retains owned receipt; uncertain stop cannot be replayed even if recording reappears', async t => {
  const f = await fixture(t); f.state.loseStart = true;
  const started = await f.session.execute({ action: 'start', ...await f.startArgs() }, {});
  assert.equal(started.error.operationMayContinue, true); const capture = started.error.details.capture;
  assert.equal(JSON.parse(await readFile(capture.receiptPath)).state, 'start-unconfirmed');
  const second = await f.session.execute({ action: 'start', ...await f.startArgs() }, {}); assert.equal(second.error.code, 'PORTAL_CAPTURE_ACTIVE');
  f.state.loseStop = true;
  const args = { action: 'stop', captureId: capture.captureId, exclusiveGuest: true };
  assert.equal((await f.session.execute(args, {})).error.code, 'PORTAL_STOP_UNCONFIRMED');
  f.state.running = true;
  assert.equal((await f.session.execute(args, {})).error.code, 'PORTAL_STOP_REPLAY_REFUSED');
  assert.equal(f.state.calls.filter(([method, url]) => method === 'GET' && url === '/api/wpr/trace').length, 1);
  assert.equal(f.session.close()[0].code, 'PORTAL_CAPTURE_MAY_CONTINUE');
});
test('Portal rejects foreign captures, endpoint/OS drift, and ambiguous new trace files', async t => {
  const f = await fixture(t);
  await assert.rejects(f.session.stop({ captureId: 'foreign', exclusiveGuest: true }, {}), { code: 'PORTAL_CAPTURE_NOT_OWNED' });
  await assert.rejects(f.session.validate({ ...f.proof, guestAddress: '127.0.0.2' }, {}), { code: 'PORTAL_TARGET_CHANGED' });
  f.state.os.ComputerName = 'Other'; await assert.rejects(f.session.validate(f.proof, {}), { code: 'PORTAL_IDENTITY_CHANGED' }); f.state.os.ComputerName = 'Phone';
  const started = await f.session.start(await f.startArgs(), {}); const args = { captureId: started.captureId, exclusiveGuest: true };
  await f.session.stop(args, {}); f.state.files.push({ ...f.state.files[0], Name: 'second.etl' });
  await assert.rejects(f.session.download(args, {}), { code: 'PORTAL_TRACE_AMBIGUOUS' });
  assert.equal((await f.session.download({ ...args, filename: 'guest trace.etl' }, {})).selectedFile.Name, 'guest trace.etl');
});
test('Portal supports direct ETL stop responses without downloading again', async t => {
  const f = await fixture(t); f.state.direct = true;
  const started = await f.session.start(await f.startArgs(), {});
  const stopped = await f.session.stop({ captureId: started.captureId, exclusiveGuest: true }, {});
  assert.equal(stopped.state, 'stopped-artifact-verified'); assert.equal(stopped.trace.bytes, 4096);
  await f.session.download({ captureId: started.captureId }, {});
  assert.equal(f.state.calls.some(([, url]) => url.startsWith('/api/wpr/tracefile?')), false);
});

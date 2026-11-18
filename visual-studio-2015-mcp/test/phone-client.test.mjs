import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PhoneBridgeClient } from '../src/phone-client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(options = {}) {
  const { launchDelayMs = 0, readyDelayMs = 0, readyMode = 'normal', ...clientOptions } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), 'vs-phone-transport-'));
  const script = path.join(root, 'bridge.mjs'), log = path.join(root, 'calls.jsonl');
  await writeFile(script, `import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const lines=readline.createInterface({input:process.stdin});
const announce=()=>{if(process.argv[4]==='invalid'){process.stdout.write('{"kind":"wrong"}\\n');return;}if(process.argv[4]==='exit'){process.exit(7);return;}if(process.argv[4]==='never')return;process.stdout.write('{"kind":"ready","protocolVersion":1,"backend":"xde-session"}\\n');};
setTimeout(announce,Number(process.argv[3]));
lines.on('line',async line=>{const r=JSON.parse(line);appendFileSync(process.argv[2],JSON.stringify({id:r.id,operation:r.operation,pid:process.pid})+'\\n');
if(r.operation==='crash'){process.exit(4);return;}
if(r.operation==='hang')return;
if(r.operation==='stuck'){lines.removeAllListeners('close');setInterval(()=>{},1000);return;}
if(r.operation==='hold'){globalThis.held=true;}
if(r.operation==='invalid'){process.stdout.write('invalid json\\n');return;}
if(r.operation==='null'){process.stdout.write('null\\n');return;}
if(r.operation==='oversized'){process.stdout.write('x'.repeat(2048));return;}
if(r.delayMs)await new Promise(resolve=>setTimeout(resolve,r.delayMs));
process.stdout.write(JSON.stringify({id:r.id,result:{pid:process.pid,operation:r.operation,sessionId:String(process.pid)}})+'\\n');
});lines.on('close',()=>{if(globalThis.held)appendFileSync(process.argv[2],JSON.stringify({operation:'cleanup-key-up',pid:process.pid})+'\\n');process.exit(0);});`);
  let launches = 0; const children = [];
  const client = new PhoneBridgeClient({ launch: async () => {
    launches++; await delay(typeof launchDelayMs === 'function' ? launchDelayMs(launches) : launchDelayMs);
    const child = spawn(process.execPath, [script, log, String(readyDelayMs), readyMode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); return child;
  }, cleanupGraceMs: 250, ...clientOptions });
  const calls = async () => (await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const until = async predicate => { const end = Date.now() + 5000; while (!(await predicate())) { if (Date.now() > end) throw new Error('Fixture condition timed out'); await delay(10); } };
  return { client, calls, until, children, launches: () => launches };
}

test('phone emulator transport keeps one bridge and skips cancelled queued commands', async () => {
  const f = await fixture();
  try {
    const first = f.client.request('first', { delayMs: 200 });
    await f.until(async () => (await f.calls()).some(call => call.operation === 'first'));
    const abort = new AbortController();
    const cancelled = f.client.request('must-not-run', {}, { signal: abort.signal }).catch(error => error);
    abort.abort();
    assert.equal((await cancelled).operationMayContinue, false);
    const result = await first;
    const later = await f.client.request('later');
    assert.equal(result.pid, later.pid); assert.equal(f.launches(), 1);
    assert.deepEqual((await f.calls()).map(call => call.operation), ['first', 'later']);
  } finally { await f.client.stop(); }
});

test('in-flight cancellation drains its response before the next command', async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const first = f.client.request('mutation', { delayMs: 250 }, { signal: abort.signal }).catch(error => error);
    await f.until(async () => (await f.calls()).some(call => call.operation === 'mutation'));
    abort.abort(); assert.equal((await first).operationMayContinue, true);
    const after = f.client.request('state');
    await delay(30);
    assert.deepEqual((await f.calls()).map(call => call.operation), ['mutation']);
    const result = await after; assert.equal(result.operation, 'state'); assert.equal(f.launches(), 1);
  } finally { await f.client.stop(); }
});

test('a hung bridge invalidates pending calls and restarts without replay', async () => {
  const f = await fixture();
  try {
    const original = await f.client.request('attach');
    const hung = f.client.request('hang', {}, { timeoutMs: 200 }).catch(error => error);
    const queued = f.client.request('queued').catch(error => error);
    const [failure, dropped] = await Promise.all([hung, queued]);
    assert.equal(failure.code, 'PHONE_BRIDGE_TIMEOUT'); assert.equal(dropped.code, 'PHONE_BRIDGE_TIMEOUT');
    assert.equal(failure.operationMayContinue, true);
    const replacement = await f.client.request('attach');
    assert.notEqual(original.pid, replacement.pid); assert.equal(f.launches(), 2);
    assert.equal((await f.calls()).some(call => call.operation === 'queued'), false);
  } finally { await f.client.stop(); }
});

test('invalid or oversized responses reset transport rather than parsing partial state', async () => {
  for (const [operation, expected] of [['invalid', 'PHONE_PROTOCOL_ERROR'], ['null', 'PHONE_PROTOCOL_ERROR'], ['oversized', 'PHONE_RESPONSE_TOO_LARGE']]) {
    const f = await fixture({ maxMessageBytes: 1024 });
    try {
      const error = await f.client.request(operation).catch(error => error);
      assert.equal(error.code, expected);
      assert.equal((await f.client.request('healthy')).operation, 'healthy');
    } finally { await f.client.stop(); }
  }
});

test('stop releases the bridge and rejects subsequent requests', async () => {
  const f = await fixture();
  await f.client.request('ready');
  const child = f.client.child;
  await f.client.stop();
  assert.notEqual(child.exitCode, null);
  await assert.rejects(f.client.request('later'), { code: 'PHONE_BRIDGE_CLOSED' });
});

test('cold initialization has a separate budget from queue and command execution', async () => {
  const f = await fixture({ launchDelayMs: 300, readyDelayMs: 300, initializationTimeoutMs: 3000 });
  try {
    const start = Date.now();
    const first = f.client.request('cold', {}, { timeoutMs: 400 });
    const queued = f.client.request('also-cold', {}, { timeoutMs: 400 });
    const [a, b] = await Promise.all([first, queued]);
    assert.ok(Date.now() - start >= 600);
    assert.equal(a.pid, b.pid); assert.equal(f.launches(), 1);
  } finally { await f.client.stop(); }
});

test('initialization timeout rejects undispatched commands and kills late launch results', async () => {
  const f = await fixture({ launchDelayMs: n => n === 1 ? 1800 : 0, initializationTimeoutMs: 1200 });
  try {
    const first = f.client.request('must-not-run').catch(error => error);
    const queued = f.client.request('also-must-not-run').catch(error => error);
    assert.equal((await first).code, 'PHONE_INITIALIZATION_TIMEOUT');
    assert.equal((await queued).code, 'PHONE_INITIALIZATION_TIMEOUT');
    await delay(800);
    await f.until(() => f.children[0] && (f.children[0].exitCode !== null || f.children[0].signalCode !== null));
    assert.deepEqual(await f.calls(), []);
    assert.equal((await f.client.request('healthy')).operation, 'healthy');
    assert.equal(f.launches(), 2);
  } finally { await f.client.stop(); }
});

test('STA readiness failure never dispatches an phone emulator command', async () => {
  for (const [readyMode, expected] of [['invalid', 'PHONE_PROTOCOL_ERROR'], ['exit', 'PHONE_BRIDGE_RESET'], ['never', 'PHONE_INITIALIZATION_TIMEOUT']]) {
    const f = await fixture({ readyMode, initializationTimeoutMs: 2000 });
    try {
      const error = await f.client.request('must-not-run').catch(value => value);
      assert.equal(error.code, expected);
      assert.deepEqual(await f.calls(), []);
      await f.until(() => f.children[0] && (f.children[0].exitCode !== null || f.children[0].signalCode !== null));
    } finally { await f.client.stop(); }
  }
});

test('cancellation during initialization never dispatches the cancelled request', async () => {
  const f = await fixture({ launchDelayMs: 250, initializationTimeoutMs: 2000 });
  try {
    const abort = new AbortController();
    const pending = f.client.request('cancel-before-ready', {}, { signal: abort.signal, timeoutMs: 100 }).catch(error => error);
    await delay(50); abort.abort();
    assert.equal((await pending).operationMayContinue, false);
    assert.equal((await f.client.request('state', {}, { timeoutMs: 500 })).operation, 'state');
    assert.deepEqual((await f.calls()).map(item => item.operation), ['state']);
  } finally { await f.client.stop(); }
});

test('connection shutdown during initialization is bounded and late children are not orphaned', async () => {
  const f = await fixture({ launchDelayMs: 300, initializationTimeoutMs: 5000 });
  const pending = f.client.request('must-not-run').catch(error => error);
  await delay(30);
  const start = Date.now(); await f.client.stop();
  assert.ok(Date.now() - start < 1000);
  assert.equal((await pending).code, 'PHONE_BRIDGE_CLOSED');
  await delay(350);
  await f.until(() => f.children[0] && (f.children[0].exitCode !== null || f.children[0].signalCode !== null));
  assert.deepEqual(await f.calls(), []);
});

test('a request timeout uses EOF to release held keys before replacing the controller', async () => {
  const f = await fixture();
  try {
    const held = await f.client.request('hold');
    await assert.rejects(f.client.request('hang', {}, { timeoutMs: 100 }), { code: 'PHONE_BRIDGE_TIMEOUT', cleanupStatus: 'pending' });
    const shutdown = await f.client.waitForShutdown();
    assert.equal(shutdown.forcedTermination, false);
    assert.equal(shutdown.cleanupStatus, 'completed');
    assert.ok((await f.calls()).some(call => call.operation === 'cleanup-key-up' && call.pid === held.pid));
    assert.notEqual((await f.client.request('open')).pid, held.pid);
  } finally { await f.client.stop(); }
});

test('a stuck SDK controller is killed only after its cleanup grace period', async () => {
  const f = await fixture({ cleanupGraceMs: 150 });
  try {
    await f.client.request('hold');
    const start = Date.now();
    await assert.rejects(f.client.request('stuck', {}, { timeoutMs: 100 }), { code: 'PHONE_BRIDGE_TIMEOUT' });
    const shutdown = await f.client.waitForShutdown();
    assert.ok(Date.now() - start >= 240);
    assert.equal(shutdown.forcedTermination, true); assert.equal(shutdown.cleanupStatus, 'unknown');
    assert.equal((await f.calls()).some(call => call.operation === 'cleanup-key-up'), false);
  } finally { await f.client.stop(); }
});

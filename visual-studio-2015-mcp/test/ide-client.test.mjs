import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { IdeBridgeClient } from '../src/ide-client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vs-ide-transport-'));
  const script = path.join(root, 'bridge.mjs'), log = path.join(root, 'calls.jsonl');
  await writeFile(script, `import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const lines=readline.createInterface({input:process.stdin});
lines.on('line',async line=>{const r=JSON.parse(line);appendFileSync(process.argv[2],JSON.stringify({id:r.id,operation:r.operation,pid:process.pid})+'\\n');
if(r.operation==='crash'){process.exit(4);return;}
if(r.operation==='hang')return;
if(r.operation==='invalid'){process.stdout.write('invalid json\\n');return;}
if(r.operation==='null'){process.stdout.write('null\\n');return;}
if(r.operation==='oversized'){process.stdout.write('x'.repeat(2048));return;}
if(r.delayMs)await new Promise(resolve=>setTimeout(resolve,r.delayMs));
process.stdout.write(JSON.stringify({id:r.id,result:{pid:process.pid,operation:r.operation,sessionId:String(process.pid)}})+'\\n');
});lines.on('close',()=>process.exit(0));`);
  let launches = 0;
  const client = new IdeBridgeClient({ launch: async () => {
    launches++; return spawn(process.execPath, [script, log], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }, ...options });
  const calls = async () => (await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const until = async predicate => { const end = Date.now() + 5000; while (!(await predicate())) { if (Date.now() > end) throw new Error('Fixture condition timed out'); await delay(10); } };
  return { client, calls, until, launches: () => launches };
}

test('IDE transport keeps one bridge and skips cancelled queued commands', async () => {
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
    assert.equal(failure.code, 'IDE_BRIDGE_TIMEOUT'); assert.equal(dropped.code, 'IDE_BRIDGE_TIMEOUT');
    assert.equal(failure.operationMayContinue, true);
    const replacement = await f.client.request('attach');
    assert.notEqual(original.pid, replacement.pid); assert.equal(f.launches(), 2);
    assert.equal((await f.calls()).some(call => call.operation === 'queued'), false);
  } finally { await f.client.stop(); }
});

test('invalid or oversized responses reset transport rather than parsing partial state', async () => {
  for (const [operation, expected] of [['invalid', 'IDE_PROTOCOL_ERROR'], ['null', 'IDE_PROTOCOL_ERROR'], ['oversized', 'IDE_RESPONSE_TOO_LARGE']]) {
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
  await assert.rejects(f.client.request('later'), { code: 'IDE_BRIDGE_CLOSED' });
});

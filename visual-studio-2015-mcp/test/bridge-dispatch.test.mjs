import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { IdeBridgeClient } from '../src/ide-client.mjs';
import { PhoneBridgeClient } from '../src/phone-client.mjs';

const bridge = `
const { createInterface } = require('node:readline');
console.log(JSON.stringify({ kind: 'ready', protocolVersion: 1, backend: 'xde-session' }));
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.operation === 'exit') process.exit(4);
  console.log(JSON.stringify({ id: request.id, result: request.operation }));
});
`;

for (const [prefix, Client] of [['IDE', IdeBridgeClient], ['PHONE', PhoneBridgeClient]]) {
  test(`${prefix} bridge exit distinguishes acknowledged, written and queued requests`, async t => {
    const client = new Client({ launch: () => spawn(process.execPath, ['-e', bridge], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
    t.after(() => client.stop());
    assert.equal(await client.request('acknowledged'), 'acknowledged');
    const active = client.request('exit').catch(error => error);
    const queued = client.request('queued').catch(error => error);
    const [written, waiting] = await Promise.all([active, queued]);
    assert.equal(written.code, prefix + '_BRIDGE_RESET');
    assert.equal(waiting.code, prefix + '_BRIDGE_RESET');
    assert.equal(written.operationMayContinue, true);
    assert.equal(waiting.operationMayContinue, false);
  });
}

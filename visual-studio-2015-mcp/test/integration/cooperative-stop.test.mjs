import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { invokeBackend, stopChildren } from '../../src/bridge.mjs';

test('bridge cancellation and disconnect await cooperative cleanup', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs2015-cooperative-test-'));
  const script = path.join(directory, 'owned-fixture.ps1');
  await writeFile(script, `$r=[Console]::In.ReadToEnd()|ConvertFrom-Json
[IO.File]::WriteAllText($r.ready,'ready')
try { while(-not [IO.File]::Exists($r.stopFile)) { Start-Sleep -Milliseconds 50 } }
finally { Start-Sleep -Milliseconds 200; [IO.File]::WriteAllText($r.cleaned,'cleaned') }
[Console]::Out.WriteLine('{"cleanupVerified":true}')
`);
  for (const mode of ['abort', 'disconnect']) {
    const stopFile = path.join(directory, mode + '.stop'), ready = path.join(directory, mode + '.ready'), cleaned = path.join(directory, mode + '.cleaned');
    const controller = new AbortController();
    const pending = invokeBackend({ stopFile, ready, cleaned }, { script, cooperativeStopFile: stopFile, signal: controller.signal }).catch(error => error);
    const deadline = Date.now() + 10000;
    while (true) {
      try { await access(ready); break; } catch { if (Date.now() > deadline) throw new Error('Fixture did not start'); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (mode === 'abort') controller.abort(); else await stopChildren();
    const error = await pending;
    assert.ok(error instanceof Error);
    assert.equal(error.backendResult.cleanupVerified, true);
    assert.equal(await readFile(cleaned, 'utf8'), 'cleaned');
  }
});

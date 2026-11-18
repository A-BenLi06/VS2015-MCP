import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function fixture(name) {
  const shell = path.join(process.env.SystemRoot, 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe');
  const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
  const script = fileURLToPath(new URL(`./fixtures/${name}.ps1`, import.meta.url));
  const { stdout } = await promisify(execFile)(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-ScriptsDirectory', scripts], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

test('persistent phone lifecycle keeps one input client and releases only held keys', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const result = await fixture('Test-PhoneSessionLifecycle');
  assert.equal(result.passed, true); assert.equal(result.checks, 11);
  assert.equal(result.firstSession.client, 1); assert.equal(result.firstSession.input, 1);
  assert.deepEqual(result.close.unreleasedKeys, []); assert.equal(result.close.vmClosed, false);
  assert.deepEqual(result.eof.unreleasedKeys, []);
});

test('CoreCon profile binding requires both SDK endpoint addresses and preserves connection ownership', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const result = await fixture('Test-PhoneBinding');
  assert.equal(result.passed, true); assert.equal(result.checks, 11);
  assert.equal(result.preexistingConnectionLog, 'client:dispose');
});

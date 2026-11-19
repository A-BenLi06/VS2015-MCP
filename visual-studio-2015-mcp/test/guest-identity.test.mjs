import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const product = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Guest-identity helper timeout')); }, 120000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code) reject(new Error(`${stdout}\n${stderr}`.trim()));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

test('GuestDebugAppIdentity and DebuggerLiterals reject fabricated or partial values', { skip: process.platform !== 'win32' || process.env.VS2015_TEST_INSTALLED_SDK !== '1', timeout: 180000 }, async () => {
  const pwsh = process.env.VS2015_MCP_PWSH ?? 'pwsh.exe';
  const built = JSON.parse(await run(pwsh, ['-NoProfile', '-File', path.join(product, 'scripts/Build-IdeBridge.ps1')], '{}'));
  assert.ok(built.executablePath, built.error?.message);
  const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows';
  const csc = path.join(windows, 'Microsoft.NET/Framework/v4.0.30319/csc.exe');
  const root = await mkdtemp(path.join(os.tmpdir(), 'v15-guest-identity-unit-'));
  try {
    const executable = path.join(root, 'GuestIdentityTests.exe');
    await run(csc, ['/nologo', '/utf8output', '/platform:x86', '/reference:System.Web.Extensions.dll', `/out:${executable}`, path.join(product, 'test/fixtures/GuestIdentityTests.cs')]);
    const value = JSON.parse(await run(executable, [built.executablePath]));
    assert.equal(value.passed, true);
    assert.equal(value.checks, 22);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

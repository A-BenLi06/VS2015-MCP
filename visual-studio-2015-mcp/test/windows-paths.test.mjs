import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../', import.meta.url));

test('WindowsPaths resolves known folders and child SDK defaults without OS directory env vars', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const pwsh = process.env.VS2015_MCP_PWSH ?? 'pwsh.exe';
  const scripts = path.join(root, 'scripts');
  const fixture = path.join(root, 'test/fixtures/Test-WindowsPaths.ps1');
  const { stdout } = await promisify(execFile)(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-ScriptsDirectory', scripts], {
    windowsHide: true,
    maxBuffer: 1048576,
  });
  const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  assert.equal(result.passed, true);
  assert.equal(result.childDefaultsAdded, true);
  assert.equal(result.existingValuesPreserved, true);
  assert.equal(result.parentEnvironmentStillAbsent, true);
  assert.ok(Array.isArray(result.programDirectories) && result.programDirectories.length >= 1);
});

test('VS2015, debug, profiler and phone CLI discovery succeed without inherited OS directory env vars', { skip: process.platform !== 'win32' || process.env.VS2015_TEST_INSTALLED_SDK !== '1', timeout: 120000 }, async t => {
  const client = new Client({ name: 'windows-paths-minimal-env', version: '1' });
  // Keep SystemRoot for Node/Win32 CSPRNG initialization while clearing all
  // optional program-directory and WINDIR environment variables (matching MCP stdio defaults).
  const env = {
    ProgramFiles: '',
    'ProgramFiles(x86)': '',
    ProgramW6432: '',
    windir: '',
    PROGRAMFILES: '',
    'PROGRAMFILES(X86)': '',
    PROGRAMW6432: '',
    WINDIR: '',
    ...(process.env.VS2015_MCP_PWSH ? { VS2015_MCP_PWSH: process.env.VS2015_MCP_PWSH } : {}),
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.mjs')], cwd: root, env });
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args }, { timeout: 60000, signal: t.signal });
    assert.equal(res.isError, false, `${name}: ${JSON.stringify(res)}`);
    return res.structuredContent;
  };
  try {
    await client.connect(transport);
    const vs = await call('vs2015_discover');
    assert.ok(vs.installation && vs.installation.root);
    const dbg = await call('vs2015_debug_discover');
    assert.ok(Array.isArray(dbg.tools));
    const prof = await call('vs2015_profiler_discover');
    assert.ok(Array.isArray(prof.tools));
    const phonePlan = await call('phone_deploy', { platform: 'wp81', action: 'devices', dryRun: true });
    assert.equal(phonePlan.dryRun, true);
    assert.ok(phonePlan.executable);
  } finally {
    await client.close();
  }
});

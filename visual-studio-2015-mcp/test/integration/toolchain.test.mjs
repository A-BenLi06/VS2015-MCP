import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MCP stdio calls the real VS2015 toolchain', { skip: process.platform !== 'win32', timeout: 600000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'VS2015 MCP 测试 '));
  const client = new Client({ name: 'vs2015-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', data => { diagnostics += data; });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 120000 });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some(tool => tool.name === 'vs2015_native'));
    const inventory = await call('vs2015_discover', {});
    assert.equal(inventory.capabilities.developerEnvironment, true, JSON.stringify(inventory.warnings));
    await t.test('installation discovery and MSBuild14 version', async () => {
      assert.match(inventory.tools.msbuild.version, /^14\./);
      const version = await call('vs2015_native', { tool: 'msbuild', arguments: ['/version'] });
      assert.match(version.stdout, /14\.0/);
    });
    await t.test('actual MSBuild relative path and separator-bearing property', async () => {
      await writeFile(path.join(dir, 'sample.proj'), '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><Target Name="Build"><WriteLinesToFile File="result.txt" Lines="$(Custom)" Overwrite="true" Encoding="UTF-8" /></Target></Project>');
      await call('vs2015_msbuild', { path: 'sample.proj', workingDirectory: dir, properties: { Custom: '中文 a,b & $(literal)' }, encoding: 'utf-8' });
      const written = (await readFile(path.join(dir, 'result.txt'), 'utf8')).replace(/^\uFEFF/, '').trim();
      assert.equal(written, '中文 a,b & $(literal)');
    });
    await t.test('native compiler/linker in a Unicode directory', async () => {
      await writeFile(path.join(dir, 'hello world.c'), '#include <stdio.h>\nint main(void) { puts("MCP_VC14_OK"); return 0; }');
      await call('vs2015_native', { tool: 'cl', arguments: ['/nologo', 'hello world.c', '/Fe:hello world.exe'], workingDirectory: dir });
      const result = await promisify(execFile)(path.join(dir, 'hello world.exe'), [], { windowsHide: true });
      assert.equal(result.stdout.trim(), 'MCP_VC14_OK');
    });
    await t.test('native output limit and SDK 8.1 selection', async () => {
      const help = await call('vs2015_tool_help', { tool: 'msbuild', maxOutputChars: 256 });
      assert.ok(help.truncated.stdout || help.truncated.stderr);
      assert.ok(help.stdout.length <= 256 && help.stderr.length <= 256);
      const inventory = await call('vs2015_discover', { sdkVersion: '8.1', store: true });
      assert.equal(inventory.capabilities.developerEnvironment, true);
      assert.match(inventory.tools.makeappx.path, /Windows Kits[\\/]8\.1[\\/]/);
    });
    await t.test('invalid root and native failures surface as tool errors', async () => {
      const root = await client.callTool({ name: 'vs2015_discover', arguments: { vsRoot: dir } }, { timeout: 120000 });
      assert.equal(root.isError, true);
      const missing = await client.callTool({ name: 'vs2015_msbuild', arguments: { path: 'missing.proj', workingDirectory: dir } }, { timeout: 120000 });
      assert.equal(missing.isError, true);
      assert.notEqual(missing.structuredContent.exitCode, 0);
    });
    await t.test('long build timeout stops the process tree', async () => {
      await writeFile(path.join(dir, 'wait.proj'), '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><Target Name="Build"><Exec Command="ping -n 20 127.0.0.1 &gt;nul" /></Target></Project>');
      const result = await client.callTool({ name: 'vs2015_msbuild', arguments: { path: 'wait.proj', workingDirectory: dir, timeoutMs: 1000 } }, { timeout: 120000 });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.timedOut, true);
    });
    assert.equal(diagnostics, '', 'Server must not emit unexpected diagnostics.');
  } finally {
    await client.close();
    // dir is the exact unique temporary directory created above.
    await rm(dir, { recursive: true, force: true });
  }
});

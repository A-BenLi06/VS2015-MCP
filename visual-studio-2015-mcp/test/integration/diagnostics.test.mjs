import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MSBuild14 ILogger diagnostics flow through MCP and history', { skip: process.platform !== 'win32', timeout: 240000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'VS diagnostics 中文 '));
  const project = path.join(directory, 'case.proj');
  await writeFile(project, '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><Target Name="Build"><Warning Code="W123" Text="中文 warning" File="source.cs"/><Error Code="E456" Text="intentional failure" File="source.cs"/></Target></Project>');
  const client = new Client({ name: 'diagnostics-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: { ...process.env, VS2015_MCP_HISTORY: path.join(directory, 'history') } }));
  try {
    const result = await client.callTool({ name: 'vs2015_build_diagnostics', arguments: { path: project, workingDirectory: directory, setupTimeoutMs: 120000 } }, { timeout: 210000, signal: t.signal });
    assert.equal(result.isError, true);
    const data = result.structuredContent;
    assert.equal(data.diagnostics.complete, true, JSON.stringify(data));
    assert.equal(data.diagnostics.errorCount, 1); assert.equal(data.diagnostics.warningCount, 1);
    assert.equal(data.diagnostics.diagnostics[0].code, 'W123');
    assert.match(data.diagnostics.diagnostics[0].message, /中文/);
    const filtered = await client.callTool({ name: 'vs2015_diagnostics_read', arguments: { runId: data.runId, artifactId: data.artifactId, severity: 'error' } });
    assert.equal(filtered.structuredContent.diagnostics.length, 1);
    assert.equal(filtered.structuredContent.diagnostics[0].code, 'E456');
    assert.equal(filtered.structuredContent.warningCount, 1);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

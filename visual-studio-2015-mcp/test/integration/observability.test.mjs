import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MCP records real action times and compares imported localized reports', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-observe-'));
  const client = new Client({ name: 'observability-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: { ...process.env, VS2015_MCP_HISTORY: path.join(directory, 'history') } });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent;
  };
  try {
    await client.connect(transport);
    const a = await call('vs2015_history_create', { operation: 'load', context: { target: 'fixture' }, revision: 'before' });
    const b = await call('vs2015_history_create', { operation: 'load', context: { target: 'fixture' }, revision: 'after' });
    const solution = path.join(directory, 'test.sln');
    await writeFile(solution, 'Microsoft Visual Studio Solution File, Format Version 12.00\r\n');
    const action = await call('vs2015_record_action', { runId: a.id, label: 'Inspect fixture', toolName: 'vs2015_inspect_solution', arguments: { path: solution } });
    assert.ok(action.actionId);
    const history = await call('vs2015_history_read', { runId: a.id });
    assert.deepEqual(history.events.map(event => event.kind), ['actionStarted', 'actionFinished']);
    assert.equal(JSON.stringify(history.events).includes(solution), false);
    const reportA = path.join(directory, 'before.csv'), reportB = path.join(directory, 'after.csv');
    await writeFile(reportA, '函数,样本\nA,10\n'); await writeFile(reportB, '函数,样本\nA,30\nB,2\n');
    const mapping = { symbolColumn: '函数', valueColumn: '样本', metric: 'cpu', unit: 'samples', valueSemantics: 'total', attribution: 'exclusive', collector: 'fixture-v1', scope: 'target process', complete: true };
    const aa = await call('vs2015_hotspots_import', { ...mapping, runId: a.id, path: reportA, durationMs: 1000 });
    const bb = await call('vs2015_hotspots_import', { ...mapping, runId: b.id, path: reportB, durationMs: 2000 });
    const comparison = await call('vs2015_hotspots_compare', { baselineRunId: a.id, baselineArtifactId: aa.artifactId, candidateRunId: b.id, candidateArtifactId: bb.artifactId });
    assert.equal(comparison.comparable, true);
    assert.equal(comparison.rows.find(row => row.symbol === 'A').delta, 5);
    assert.equal((await call('vs2015_history_list', { operation: 'load' })).runs.length, 2);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

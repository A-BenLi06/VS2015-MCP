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
    if (process.platform === 'win32') {
      const processes = await call('vs2015_processes', { nameContains: 'node', limit: 1000 });
      assert.ok(processes.processes.some(item => item.processId === process.pid && item.startTimeUtc));
      const captures = await Promise.all([a, b].map(run => call('vs2015_profile_sample', { runId: run.id, processId: process.pid, durationMs: 1000, intervalMs: 1000, includeClr: false })));
      assert.ok(captures.every(value => value.summary.complete));
      assert.ok(captures.every(value => value.summary.cpuDataSufficient && value.summary.intervalCount >= 1 && value.summary.cpuMs !== null));
      const baseline = { runId: a.id, artifactId: captures[0].artifactId }, candidate = { runId: b.id, artifactId: captures[1].artifactId };
      const processComparison = await call('vs2015_profile_compare', { baseline, candidate });
      assert.equal(processComparison.comparable, true, JSON.stringify(processComparison));
      assert.ok(processComparison.rows.some(row => row.metric === 'peakPrivateBytes'));
      const clr = await call('vs2015_profile_compare', { baseline, candidate, groups: ['clr'] });
      assert.equal(clr.comparable, false);
      const artifact = await call('vs2015_history_artifact', baseline);
      await writeFile(artifact.data.source.path, '{}');
      const tampered = await client.callTool({ name: 'vs2015_profile_summary', arguments: baseline });
      assert.equal(tampered.isError, true);
      assert.match(tampered.structuredContent.error.message, /hash changed/);
    }
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

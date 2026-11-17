import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseCsv } from '../../src/history.mjs';

const enabled = process.platform === 'win32' && process.env.VS2015_TEST_PERFVIEW && process.env.VS2015_TEST_ETL && process.env.VS2015_TEST_TRACE_PROCESS;
test('real PerfView reports from an existing trace flow into hotspot history', { skip: !enabled, timeout: 300000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v15-pv-'));
  const client = new Client({ name: 'perfview-offline-runtime', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: { ...process.env, VS2015_MCP_HISTORY: path.join(directory, 'history') } }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 240000, signal: t.signal });
    assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent;
  };
  try {
    const options = { inputPath: process.env.VS2015_TEST_ETL, perfViewPath: process.env.VS2015_TEST_PERFVIEW,
      processName: process.env.VS2015_TEST_TRACE_PROCESS, dryRun: false, timeoutMs: 180000 };
    const gc = await call('vs2015_perfview_report', { ...options, analysis: 'gcStats' });
    assert.ok(gc.reportFiles.some(file => file.endsWith('.gcStats.html')));
    assert.ok(gc.files.some(file => /\.gcStats\.\d+\.csv$/.test(file.path) && file.Length > 0));
    const cpu = await call('vs2015_perfview_report', { ...options, analysis: 'cpuCsv' });
    assert.equal(cpu.reportFiles.length, 1);
    const report = cpu.reportFiles[0];
    assert.ok(!path.relative(cpu.outputDirectory, report).startsWith('..'));
    const inspected = await call('vs2015_report_inspect', { path: report });
    assert.ok(inspected.rowCount > 0); assert.ok(inspected.headers.includes('Name')); assert.ok(inspected.headers.includes('Exc'));
    const rows = parseCsv(await readFile(report, 'utf8')), first = rows[0].indexOf('First'), last = rows[0].indexOf('Last');
    const durationMs = Math.max(...rows.slice(1).map(row => Number(row[last]))) - Math.min(...rows.slice(1).map(row => Number(row[first])));
    assert.ok(durationMs > 0);
    const runs = await Promise.all(['before', 'after'].map(revision => call('vs2015_history_create', {
      operation: 'offline fixture', context: { process: options.processName }, revision })));
    const imported = await Promise.all(runs.map(run => call('vs2015_hotspots_import', { runId: run.id, path: report,
      symbolColumn: 'Name', valueColumn: 'Exc', metric: 'CPU exclusive export', unit: 'exported CPU metric', valueSemantics: 'total',
      attribution: 'exclusive', collector: `PerfView/${cpu.collectorVersion}`, scope: options.processName, durationMs, complete: false })));
    const comparison = await call('vs2015_hotspots_compare', { baselineRunId: runs[0].id, baselineArtifactId: imported[0].artifactId,
      candidateRunId: runs[1].id, candidateArtifactId: imported[1].artifactId, normalization: 'none' });
    assert.equal(comparison.comparable, true);
    assert.ok(comparison.rows.some(row => row.baseline > 0));
    assert.ok(comparison.rows.every(row => row.delta === 0));
  } finally { await client.close(); }
});

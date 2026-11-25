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
const appCpuContext = process.env.VS2015_TEST_APP_CPU_CONTEXT;
test('public appCpu reproduces process attribution and native hotspots from the Mobile ETL', {
  skip: process.platform !== 'win32' || !process.env.VS2015_TEST_PERFVIEW || !appCpuContext, timeout: 300000,
}, async t => {
  const fixture = JSON.parse(await readFile(appCpuContext, 'utf8'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v15-appcpu-'));
  const client = new Client({ name: 'app-cpu-runtime', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: { ...process.env, VS2015_MCP_HISTORY: directory } }));
  const options = { analysis: 'appCpu', packageFullName: fixture.packageFullName, inputPath: fixture.inputPath,
    processId: fixture.processId, perfViewPath: process.env.VS2015_TEST_PERFVIEW, dryRun: false, timeoutMs: 90000 };
  const call = args => client.callTool({ name: 'vs2015_perfview_report', arguments: args }, { timeout: 110000, signal: t.signal });
  try {
    const response = await call({ ...options, pdbPaths: [fixture.pdbPath] });
    assert.equal(response.isError, false, JSON.stringify(response.structuredContent));
    const result = response.structuredContent, cpu = result.appCpu;
    assert.equal(result.traceSha256, fixture.sha256);
    assert.equal(cpu.process.processId, fixture.processId);
    assert.equal(cpu.process.packageFullName, fixture.packageFullName);
    assert.equal(cpu.process.applicationId, fixture.applicationId);
    assert.equal(cpu.process.identityEvent, 'Process/Start');
    assert.equal(cpu.attributedSamples, 23996);
    assert.equal(cpu.stackSamples, 14167);
    assert.equal(cpu.missingStackSamples, 9829);
    assert.equal(cpu.unresolvedSamples, 459);
    assert.equal(cpu.pdbs[0].matched, true);
    assert.match(cpu.hotspots[0].function, /!FixtureHotMix$/);
    assert.equal(cpu.hotspots[0].samples, 23536);
    assert.deepEqual(cpu.nativeStacks[0].framesLeafToRoot.map(frame => frame.split('!').at(-1)), ['FixtureHotMix', 'FixtureBatchLoop', 'RunFixtureBatch']);
    assert.equal(cpu.nativeStacks[0].samples, 13825);
    const artifact = await client.callTool({ name: 'vs2015_history_artifact', arguments: { runId: result.runId, artifactId: result.artifactId } });
    assert.equal(artifact.isError, false);
    assert.deepEqual(artifact.structuredContent.data.result.appCpu, cpu);
    const unsymbolized = await call({ ...options, processIndex: cpu.process.processIndex });
    assert.equal(unsymbolized.isError, false);
    assert.equal(unsymbolized.structuredContent.appCpu.unresolvedSamples, 23996);
    assert.equal(unsymbolized.structuredContent.appCpu.stackSamples, 14167);
    const unknown = await call({ ...options, processIndex: 2147483647 });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.error.code, 'ETL_PROCESS_NOT_FOUND');
    t.diagnostic(`Mobile appCpu evidence: ${result.artifactPath}`);
  } finally { await client.close(); }
});
test('real guest ETL event export reports content, raw loss headers and lifetime observations through MCP', {
  skip: process.platform !== 'win32' || !process.env.VS2015_TEST_PERFVIEW || !process.env.VS2015_TEST_GUEST_ETL, timeout: 300000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v15-guest-events-'));
  const client = new Client({ name: 'guest-event-runtime', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: { ...process.env, VS2015_MCP_HISTORY: directory } }));
  try {
    const response = await client.callTool({ name: 'vs2015_perfview_report', arguments: {
      analysis: 'eventsXml', inputPath: process.env.VS2015_TEST_GUEST_ETL, perfViewPath: process.env.VS2015_TEST_PERFVIEW, dryRun: false, timeoutMs: 180000,
    } }, { timeout: 240000, signal: t.signal });
    assert.equal(response.isError, false, JSON.stringify(response.structuredContent));
    const result = response.structuredContent, summary = result.eventSummary;
    assert.equal(summary.eventContentValidated, true); assert.ok(summary.eventCount > 0); assert.ok(summary.cpuSampleEvents > 0);
    assert.ok(summary.traceHeaders.length > 0); assert.ok(summary.processObservations.length > 0);
    assert.equal(summary.applicationAttributionVerified, false); assert.equal(summary.summaryTruncated, false);
    const saved = await client.callTool({ name: 'vs2015_history_artifact', arguments: { runId: result.runId, artifactId: result.artifactId } });
    assert.equal(saved.isError, false); assert.deepEqual(saved.structuredContent.data.result.eventSummary, summary);
    t.diagnostic(`Guest events ${summary.eventCount}, CPU sample events ${summary.cpuSampleEvents}, unresolved ${summary.unresolvedEventCount}; ${result.artifactPath}`);
  } finally { await client.close(); }
});
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

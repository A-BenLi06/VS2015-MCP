import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { profilerDefinitions } from '../../src/profiler.mjs';

test('profiler CLI inventory, safe report plans and permission refusal', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs2015-profile-test-'));
  const previous = process.env.VS2015_MCP_HISTORY;
  process.env.VS2015_MCP_HISTORY = path.join(directory, 'history');
  const call = async (name, input) => { const tool = profilerDefinitions.find(item => item.name === name); return tool.run(tool.schema.parse(input), {}); };
  try {
    const inventory = await call('vs2015_profiler_discover', {});
    assert.ok(inventory.tools.some(tool => tool.tool === 'vsperfreport'));
    const help = await call('vs2015_profiler_cli', { tool: 'vsperfreport', arguments: ['/?'], dryRun: false });
    assert.equal(help.exitCode, 0); assert.ok(help.execution.stdout.length > 100);
    for (const [tool, args] of [['vsperfcmd', ['/start:sample']], ['vsperfreport', ['/PackSymbols']], ['vsperfreport', ['-PackSymbols']]]) {
      const bad = await call('vs2015_profiler_cli', { tool, arguments: args });
      assert.equal(bad.error.code, 'UNMANAGED_COMMAND_REJECTED');
    }
    const inputPath = path.join(directory, 'placeholder.vsp'); await writeFile(inputPath, 'dry-run only');
    const report = await call('vs2015_profiler_report', { inputPath, format: 'xml', startMs: 1, durationMs: 1000 });
    assert.equal(report.plan.arguments[0], '/U'); assert.ok(report.plan.arguments.includes('/MsFilter:1,1000'));
    assert.ok(report.plan.arguments.includes('/Xml'));
    const capture = await call('vs2015_profiler_capture', { processId: process.pid, durationMs: 1000 });
    assert.ok(capture.plan.arguments.includes(`/attach:${process.pid}`));
    assert.deepEqual(capture.recoveryPlan.arguments, ['/detach']);
    assert.equal(capture.plan.arguments.some(arg => arg.startsWith('/stop')), false);
    if (!inventory.isElevated) {
      const refused = await call('vs2015_profiler_capture', { processId: process.pid, dryRun: false, durationMs: 1000 });
      assert.equal(refused.error.code, 'PERMISSION_REQUIRED'); assert.ok(refused.artifactId);
      assert.deepEqual(refused.capture.steps, []);
    }
    if (!inventory.tools.some(tool => tool.tool === 'perfview')) {
      const unavailable = await call('vs2015_perfview_report', { analysis: 'gcStats', inputPath: path.join(directory, 'placeholder.etl') });
      assert.equal(unavailable.error.code, 'TOOL_NOT_FOUND');
    }
  } finally {
    if (previous === undefined) delete process.env.VS2015_MCP_HISTORY; else process.env.VS2015_MCP_HISTORY = previous;
  }
});

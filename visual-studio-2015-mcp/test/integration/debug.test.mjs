import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { debugDefinitions } from '../../src/debug.mjs';

test('real debugger inventory, safe plans and missing CDB result', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs2015-debug-integration-'));
  const previous = process.env.VS2015_MCP_HISTORY;
  process.env.VS2015_MCP_HISTORY = path.join(directory, 'history');
  const call = async (name, input) => { const tool = debugDefinitions.find(item => item.name === name); return tool.run(tool.schema.parse(input), {}); };
  try {
    const inventory = await call('vs2015_debug_discover', {});
    assert.equal(inventory.capabilities.interactiveStepping, false);
    const snapshot = await call('vs2015_debug_snapshot', { processId: process.pid, architecture: 'x64', managedRuntime: 'clr', dryRun: true });
    assert.ok(snapshot.arguments.includes('-pvr')); assert.equal(snapshot.arguments.includes('-pd'), false);
    assert.equal(snapshot.commands.at(-1), 'qd'); assert.ok(snapshot.commands.includes('.loadby sos clr'));
    const dumpPath = path.join(directory, 'placeholder.dmp');
    await writeFile(dumpPath, 'dry-run placeholder; never opened by CDB');
    const dump = await call('vs2015_debug_dump', { dumpPath, architecture: 'x64', managedRuntime: 'clr', heapSummary: true, dryRun: true });
    assert.ok(dump.commands.includes('.ecxr')); assert.equal(dump.commands.at(-1), 'q');
    assert.ok(dump.commands.includes('!dumpheap -stat')); assert.ok(dump.commands.includes('!eeheap -gc'));
    await assert.rejects(call('vs2015_debug_dump', { dumpPath, architecture: 'x64', heapSummary: true, dryRun: true }), /explicit managedRuntime/);
    const launch = await call('vs2015_debug_launch_snapshot', { executable: process.execPath, arguments: ['--version', 'a & b'], architecture: 'x64', dryRun: true });
    assert.deepEqual(launch.arguments.slice(-3), [process.execPath, '--version', 'a & b']);
    assert.equal(launch.commands.at(-1), 'q');
    if (inventory.capabilities.ideExecutableHandoff) {
      const ide = await call('vs2015_debug_ide_launch', { executable: process.execPath, dryRun: true });
      assert.deepEqual(ide.arguments, ['/DebugExe', process.execPath]); assert.equal(ide.debugSessionConfirmed, false);
    }
    if (!inventory.capabilities.cdbBatchDiagnostics) {
      const missing = await call('vs2015_debug_snapshot', { processId: process.pid, architecture: 'x64' });
      assert.match(missing.error.message, /CDB_NOT_FOUND/); assert.ok(missing.artifactId);
    }
    await assert.rejects(call('vs2015_debug_discover', { debuggerRoot: path.join(directory, 'absent') }), /debuggerRoot/);
  } finally {
    if (previous === undefined) delete process.env.VS2015_MCP_HISTORY; else process.env.VS2015_MCP_HISTORY = previous;
  }
});

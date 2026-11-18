import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const contextFile = process.env.VS2015_TEST_WP81_CONTEXT;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const guardScript = String.raw`
$ErrorActionPreference='Stop'
$v=ConvertFrom-Json ([Console]::In.ReadToEnd())
$p=Get-Process -Id ([int]$v.processId)
if($p.StartTime.ToUniversalTime().Ticks -ne ([DateTimeOffset]$v.startTimeUtc).UtcTicks){throw 'XDE start identity changed'}
if(-not [string]::Equals($p.Path,$v.executable,[StringComparison]::OrdinalIgnoreCase)){throw 'XDE executable changed'}
$c=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$v.processId)
if(-not [string]::Equals($c.CommandLine,$v.commandLine,[StringComparison]::Ordinal)){throw 'XDE command line changed'}
$id=[Guid]::Parse($v.vmId).ToString()
$vm=Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_ComputerSystem -Filter ("Name='"+$id+"'")
if(-not $vm -or $vm.ElementName -cne $v.vmName){throw 'Hyper-V VM identity changed'}
`;

test('owned WP8.1 IDE build/deploy, guest input, breakpoint, coherent context and step', {
  skip: process.platform !== 'win32' || !contextFile, timeout: 600000,
}, async t => {
  const context = JSON.parse(await readFile(path.resolve(contextFile), 'utf8'));
  const fixture = JSON.parse(await readFile(path.resolve(context.fixtureManifest), 'utf8'));
  const relative = path.relative(os.tmpdir(), fixture.root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'An isolated TEMP fixture is required');
  for (const name of ['source', 'project', 'solution']) assert.equal(path.dirname(path.resolve(fixture[name])).toLowerCase(), path.resolve(fixture.root).toLowerCase());
  assert.match(await readFile(fixture.source, 'utf8'), /MCP_BREAKPOINT/);
  const phone = context.phone;
  assert.ok(Number.isInteger(fixture.ideProcessId) && fixture.ideStartTimeUtc);
  assert.ok(Number.isInteger(phone?.processId) && phone.startTimeUtc && phone.commandLine && phone.executable && phone.vmId && phone.vmName && phone.coreConDeviceId && Number.isInteger(phone.localeId));
  assert.equal(phone.fixtureProductId.toLowerCase(), fixture.productId.toLowerCase());
  assert.ok(Number.isInteger(context.tap?.x) && Number.isInteger(context.tap?.y));
  assert.ok(Number.isInteger(context.display?.width) && Number.isInteger(context.display?.height));
  const directory = await mkdtemp(path.join(fixture.root, 'runtime-'));
  const records = [], cleanupErrors = [];
  const guardPhone = () => {
    const result = spawnSync(process.env.VS2015_MCP_PWSH || 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', guardScript], {
      input: JSON.stringify(phone), encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  const client = new Client({ name: 'phone-ide-runtime-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: { ...process.env } }));
  let sessionId, started = false, failure;
  const ownedBreakpoints = [];
  const raw = async (name, args = {}, cleanup = false) => {
    if (name.startsWith('phone_')) guardPhone();
    const result = await client.callTool({ name, arguments: args }, { timeout: 240000, ...(cleanup ? {} : { signal: t.signal }) });
    records.push({ name, args, timestampUtc: new Date().toISOString(), result: result.structuredContent, isError: result.isError });
    await writeFile(path.join(directory, 'results.json'), JSON.stringify(records, null, 2));
    return result;
  };
  const call = async (name, args = {}, cleanup = false) => {
    const result = await raw(name, args, cleanup);
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const ide = (name, args = {}, cleanup = false) => call(name, { sessionId, timeoutMs: 60000, ...args }, cleanup);
  const finishBuild = async operation => {
    const deadline = Date.now() + 180000;
    for (;;) {
      const status = await ide('vs2015_build_status', { buildId: operation.buildId });
      if (status.terminal) { assert.equal(status.complete, true); assert.equal(status.state, 'succeeded'); assert.equal(status.lastBuildInfo, 0); return status; }
      assert.ok(Date.now() < deadline, JSON.stringify(status));
      await pause(250);
    }
  };
  const checkPause = state => {
    assert.ok(state.pauseId);
    assert.equal(state.currentThread?.pauseId, state.pauseId);
    assert.equal(state.currentFrame?.pauseId, state.pauseId);
    if (state.kind === 'frames' || state.kind === 'threads') assert.ok(state.items.every(item => item.pauseId === state.pauseId));
  };
  try {
    const live = await call('phone_status', { processId: phone.processId });
    assert.equal(live.vmName, phone.vmName); assert.equal(live.shellReady, true); assert.equal(live.toolsReady, true);
    assert.equal(live.display.width, context.display.width); assert.equal(live.display.height, context.display.height);
    ({ sessionId } = await call('vs2015_attach', { processId: fixture.ideProcessId, expectedStartTimeUtc: fixture.ideStartTimeUtc }));
    const initial = await ide('vs2015_solution_status');
    assert.equal(path.resolve(initial.fullName).toLowerCase(), path.resolve(fixture.solution).toLowerCase());
    assert.equal(initial.ideLocaleId, phone.localeId); assert.equal(initial.debugger.mode, 'design');
    assert.notEqual(initial.buildState, 'vsBuildStateInProgress'); assert.equal(initial.activePlatform, 'x86');
    const projects = initial.projects.filter(project => project.fileName?.toLowerCase() === fixture.project.toLowerCase());
    assert.equal(projects.length, 1); const projectUniqueName = projects[0].uniqueName;
    assert.deepEqual(initial.startupProjects, [projectUniqueName]);
    const target = await ide('vs2015_project_properties', { projectUniqueName, propertyName: 'Debug.DeviceId' });
    assert.equal(target.properties.find(property => property.available && property.name === 'Debug.DeviceId')?.value.toLowerCase(), phone.coreConDeviceId.toLowerCase());
    await finishBuild(await ide('vs2015_build_active', { action: 'build' }));
    await finishBuild(await ide('vs2015_build_active', { action: 'deploy' }));
    const current = await ide('vs2015_solution_status');
    const deployment = await finishBuild(await ide('vs2015_project_build', { action: 'deploy', projectUniqueName, expectedConfigurationToken: current.configurationToken }));
    assert.equal(deployment.configuration, current.activeConfiguration); assert.equal(deployment.platform, current.activePlatform);
    const added = await ide('vs2015_ide_debug_breakpoints', { action: 'add', file: fixture.source, line: fixture.breakpointLine });
    ownedBreakpoints.push(...added.breakpoints.filter(breakpoint => breakpoint.owned).map(breakpoint => breakpoint.breakpointId));
    assert.ok(ownedBreakpoints.length);
    const go = await ide('vs2015_ide_debug_control', { action: 'go' }); started = true;
    assert.equal((await ide('vs2015_ide_debug_wait', { mode: 'run', afterSequence: go.afterSequence, timeoutMs: 180000 })).reached, true);
    await pause(750);
    await call('phone_screenshot', { processId: phone.processId, path: path.join(directory, 'before.png'), includeImage: false });
    await call('phone_input', { processId: phone.processId, action: 'tap', ...context.tap });
    const hit = await ide('vs2015_ide_debug_wait', { mode: 'break', afterSequence: go.afterSequence, timeoutMs: 180000 });
    assert.equal(hit.reached, true); assert.equal(hit.reason, 'dbgEventReasonBreakpoint'); checkPause(hit);
    assert.equal(path.resolve(hit.currentFrame.sourceFile).toLowerCase(), path.resolve(fixture.source).toLowerCase());
    assert.equal(hit.currentFrame.line, fixture.breakpointLine);
    for (let i = 0; i < 3; i++) {
      const frames = await ide('vs2015_ide_debug_inspect', { kind: 'frames', pauseId: hit.pauseId });
      checkPause(frames); assert.equal(frames.pauseId, hit.pauseId);
    }
    const locals = await ide('vs2015_ide_debug_inspect', { kind: 'locals', pauseId: hit.pauseId, frameId: hit.currentFrame.frameId });
    assert.equal(locals.items.find(value => value.name === 'input')?.value, String(fixture.initialCounter));
    assert.equal(locals.items.find(value => value.name === 'doubled')?.value, String(fixture.expectedDoubled));
    for (const [expression, expected] of [['input', fixture.initialCounter], ['doubled', fixture.expectedDoubled]]) {
      const value = await ide('vs2015_ide_debug_evaluate', { expression, pauseId: hit.pauseId, frameId: hit.currentFrame.frameId });
      assert.equal(value.isValidValue, true); assert.equal(value.value, String(expected)); assert.equal(value.pauseId, hit.pauseId);
    }
    const step = await ide('vs2015_ide_debug_control', { action: 'stepOver' });
    const stepped = await ide('vs2015_ide_debug_wait', { mode: 'break', afterSequence: step.afterSequence });
    assert.equal(stepped.reached, true); assert.equal(stepped.reason, 'dbgEventReasonStep'); checkPause(stepped);
    assert.notEqual(stepped.pauseId, hit.pauseId); assert.equal(stepped.currentFrame.line, fixture.breakpointLine + 1);
    for (let i = 0; i < 3; i++) {
      const frames = await ide('vs2015_ide_debug_inspect', { kind: 'frames', pauseId: stepped.pauseId });
      checkPause(frames); assert.equal(frames.pauseId, stepped.pauseId);
    }
    const stale = await raw('vs2015_ide_debug_select_frame', { sessionId, pauseId: hit.pauseId, frameId: hit.currentFrame.frameId });
    assert.equal(stale.structuredContent.error.code, 'STALE_DEBUG_CONTEXT');
    await ide('vs2015_ide_debug_control', { action: 'go' });
    await pause(1200);
    const capture = await call('phone_screenshot', { processId: phone.processId, path: path.join(directory, 'after.png'), includeImage: false });
    assert.equal(capture.width, context.display.width); assert.equal((await readFile(capture.path)).subarray(1, 4).toString(), 'PNG');
    t.diagnostic(`Guest screenshots and structured results: ${directory}`);
  } catch (error) { failure = error; }
  finally {
    if (sessionId) {
      if (started) try { await ide('vs2015_ide_debug_control', { action: 'stop' }, true); assert.equal((await ide('vs2015_ide_debug_wait', { mode: 'design' }, true)).reached, true); } catch (error) { cleanupErrors.push(error); }
      for (const breakpointId of ownedBreakpoints) try { await ide('vs2015_ide_debug_breakpoints', { action: 'delete', breakpointId }, true); } catch (error) { cleanupErrors.push(error); }
      try { assert.deepEqual((await ide('vs2015_detach', {}, true)).cleanupWarnings, []); } catch (error) { cleanupErrors.push(error); }
    }
    await client.close();
  }
  if (failure || cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors].filter(Boolean), `WP8.1 runtime failed; inspect ${directory}`);
});

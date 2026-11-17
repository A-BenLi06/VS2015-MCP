import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const vars = ['VS2015_TEST_IDE_PID', 'VS2015_TEST_IDE_START', 'VS2015_TEST_IDE_SOLUTION', 'VS2015_TEST_IDE_SOURCE'];
const enabled = process.platform === 'win32' && vars.every(name => process.env[name]);
test('persistent MCP IDE session builds, edits, hits a breakpoint and reads variables', { skip: !enabled, timeout: 300000 }, async t => {
  const processId = Number(process.env.VS2015_TEST_IDE_PID), expectedStartTimeUtc = process.env.VS2015_TEST_IDE_START;
  const solution = path.resolve(process.env.VS2015_TEST_IDE_SOLUTION), source = path.resolve(process.env.VS2015_TEST_IDE_SOURCE);
  const directory = path.dirname(solution), relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Only an explicitly owned TEMP fixture may be changed');
  assert.equal(path.dirname(source).toLowerCase(), directory.toLowerCase());
  const owned = JSON.parse(await readFile(path.join(directory, 'owned-instance.json'), 'utf8'));
  assert.equal(owned.processId, processId); assert.equal(owned.startTimeUtc, expectedStartTimeUtc);
  assert.equal(path.resolve(owned.solution).toLowerCase(), solution.toLowerCase());
  assert.equal(path.resolve(owned.source).toLowerCase(), source.toLowerCase());
  assert.equal(owned.breakpointLine, 9); assert.equal(owned.expectedInput, 21); assert.equal(owned.expectedDoubled, 42);
  const client = new Client({ name: 'ide-runtime-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: { ...process.env } }));
  const raw = (name, args) => client.callTool({ name, arguments: args }, { timeout: 90000, signal: t.signal });
  const call = async (name, args) => { const value = await raw(name, args); assert.equal(value.isError, false, JSON.stringify(value)); return value.structuredContent; };
  let sessionId, original, edited, newBreakpointIds = [];
  const scoped = (name, args = {}) => call(name, { sessionId, timeoutMs: 60000, ...args });
  const eventually = async (check, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) { const result = await check(); if (result) return result; assert.ok(Date.now() < deadline, 'Expected IDE state was not observed before deadline'); await new Promise(resolve => setTimeout(resolve, 200)); }
  };
  try {
    const instances = await call('vs2015_instances', {});
    assert.ok(instances.instances.some(row => row.processId === processId));
    const rejected = await raw('vs2015_attach', { processId, expectedStartTimeUtc: '2000-01-01T00:00:00.000Z' });
    assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent.error.code, 'TARGET_CHANGED');
    const attached = await call('vs2015_attach', { processId, expectedStartTimeUtc }); sessionId = attached.sessionId;
    const status = await scoped('vs2015_solution_status');
    assert.equal(path.resolve(status.fullName).toLowerCase(), solution.toLowerCase());
    assert.equal(status.activeConfiguration, 'Debug'); assert.equal(status.debugger.mode, 'design');

    await scoped('vs2015_document_open', { path: source, line: 9 });
    const before = await scoped('vs2015_document_read', { path: source });
    assert.equal(before.truncated, false); original = before.text; edited = original + '\r\n// IDE MCP unsaved edit validation\r\n';
    assert.equal((await scoped('vs2015_document_replace', { path: source, expectedText: original, text: edited })).saved, false);
    const changed = await scoped('vs2015_document_read', { path: source }); assert.equal(changed.text, edited); assert.equal(changed.saved, false);
    const documents = await scoped('vs2015_documents'); assert.ok(documents.documents.some(row => path.resolve(row.path).toLowerCase() === source.toLowerCase() && row.saved === false));
    const conflict = await raw('vs2015_document_replace', { sessionId, path: source, expectedText: original, text: original });
    assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.error.code, 'DOCUMENT_CONFLICT');
    await scoped('vs2015_document_replace', { path: source, expectedText: edited, text: original, save: true });
    assert.equal((await scoped('vs2015_document_read', { path: source })).saved, true);

    const build = await scoped('vs2015_build_active', { action: 'rebuild' });
    const finished = await eventually(async () => { const value = await scoped('vs2015_build_status', { buildId: build.buildId }); return value.complete ? value : false; });
    assert.equal(finished.state, 'succeeded'); assert.equal(finished.lastBuildInfo, 0); assert.equal(finished.beginEventObserved, true);
    const events = await scoped('vs2015_ide_events');
    assert.ok(events.events.some(event => event.kind === 'buildDone' && event.buildId === build.buildId));
    const errors = await scoped('vs2015_ide_errors_output', { kind: 'errors' });
    assert.ok(errors.items.some(item => item.message.includes('Intentional IDE bridge validation warning')));
    const output = await scoped('vs2015_ide_errors_output', { kind: 'output' }); assert.ok(output.panes.length > 0);
    // VSConstants.OutputWindowPaneGuid.BuildOutputPane_guid is independent of UI language.
    // Other extension-owned panes need not expose a TextDocument at all.
    const buildPane = output.panes.find(pane => pane.guid.toUpperCase() === '{1BD8A850-02D1-11D1-BEE7-00A0C913D1F8}');
    assert.ok(buildPane);
    const buildOutput = await scoped('vs2015_ide_errors_output', { kind: 'output', paneGuid: buildPane.guid });
    assert.ok(buildOutput.text.includes('IdeFixture'));

    const existing = await scoped('vs2015_ide_debug_breakpoints'); const oldIds = new Set(existing.breakpoints.map(row => row.breakpointId));
    const added = await scoped('vs2015_ide_debug_breakpoints', { action: 'add', file: source, line: 9 });
    newBreakpointIds = added.breakpoints.filter(row => !oldIds.has(row.breakpointId)).map(row => row.breakpointId);
    assert.ok(newBreakpointIds.length > 0);
    const initial = await scoped('vs2015_ide_debug_state');
    await scoped('vs2015_ide_debug_control', { action: 'go' });
    const hit = await scoped('vs2015_ide_debug_wait', { mode: 'break', afterSequence: initial.lastDebuggerEventSequence ?? 0 });
    assert.equal(hit.reached, true); assert.equal(hit.mode, 'break');
    const frames = await scoped('vs2015_ide_debug_inspect', { kind: 'frames' }); assert.ok(frames.items.some(frame => frame.function === 'Program.Main'));
    const locals = await scoped('vs2015_ide_debug_inspect', { kind: 'locals' });
    assert.ok(locals.items.some(row => row.name === 'input' && row.value === '21')); assert.ok(locals.items.some(row => row.name === 'doubled' && row.value === '42'));
    const value = await scoped('vs2015_ide_debug_evaluate', { expression: 'doubled' }); assert.equal(value.value, '42'); assert.equal(value.isValidValue, true);
    const threads = await scoped('vs2015_ide_debug_inspect', { kind: 'threads' }); assert.ok(threads.items.length > 0);
    const beforeStep = await scoped('vs2015_ide_debug_state');
    await scoped('vs2015_ide_debug_control', { action: 'stepOver' });
    const stepped = await scoped('vs2015_ide_debug_wait', { mode: 'break', afterSequence: beforeStep.lastDebuggerEventSequence });
    assert.equal(stepped.reached, true); assert.equal(stepped.reason, 'dbgEventReasonStep');
    await scoped('vs2015_ide_debug_control', { action: 'stop' });
    assert.equal((await scoped('vs2015_ide_debug_wait', { mode: 'design' })).reached, true);
    for (const breakpointId of newBreakpointIds) await scoped('vs2015_ide_debug_breakpoints', { action: 'delete', breakpointId });
    newBreakpointIds = [];
    assert.equal((await scoped('vs2015_detach')).ideClosed, false);
    const invalid = await raw('vs2015_solution_status', { sessionId }); assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, 'SESSION_NOT_FOUND');
    sessionId = undefined;
    process.kill(processId, 0); // Detaching the bridge must leave the owned IDE alive.
  } finally {
    if (sessionId) {
      try { const state = await scoped('vs2015_ide_debug_state'); if (state.mode !== 'design') { await scoped('vs2015_ide_debug_control', { action: 'stop' }); await scoped('vs2015_ide_debug_wait', { mode: 'design' }); } } catch {}
      for (const breakpointId of newBreakpointIds) { try { await scoped('vs2015_ide_debug_breakpoints', { action: 'delete', breakpointId }); } catch {} }
      if (original !== undefined) { try { const current = await scoped('vs2015_document_read', { path: source }); if (current.text === edited || current.text === original) await scoped('vs2015_document_replace', { path: source, expectedText: current.text, text: original, save: true }); } catch {} }
      try { await scoped('vs2015_detach'); } catch {}
    }
    await client.close();
  }
});

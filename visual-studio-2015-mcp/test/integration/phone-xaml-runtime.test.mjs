import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const contextFile = process.env.VS2015_TEST_WP81_XAML_CONTEXT;
const enabled = process.platform === 'win32' && Boolean(contextFile);
const within = (root, file) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

test('owned WP8.1 PhoneSession verifies guest identity, inspects XAML tree, sets text and invokes button once', { skip: !enabled, timeout: 600000 }, async t => {
  assert.ok(within(os.tmpdir(), contextFile), 'Context file must live in TEMP');
  const context = JSON.parse(await readFile(path.resolve(contextFile), 'utf8'));
  const fixture = JSON.parse(await readFile(path.resolve(context.fixtureManifest), 'utf8'));
  assert.ok(within(os.tmpdir(), fixture.root));
  assert.equal(context.ownsIde, true);
  assert.equal(context.ownsXde, true);

  const client = new Client({ name: 'phone-xaml-runtime-test', version: '1' });
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'src/server.mjs')], cwd: repo }));

  const raw = (name, args = {}, timeout = 300000) => client.callTool({ name, arguments: args }, { timeout, signal: t.signal });
  const call = async (name, args = {}, timeout = 300000) => {
    const res = await raw(name, args, timeout);
    assert.equal(res.isError, false, `${name}: ${JSON.stringify(res)}`);
    return res.structuredContent;
  };

  let ideSessionId;
  let phoneSessionId;
  const artifacts = await mkdtemp(path.join(fixture.root, 'xaml-mcp-'));

  try {
    ideSessionId = (await call('vs2015_attach', { processId: context.ide.processId, expectedStartTimeUtc: context.ide.startTimeUtc })).sessionId;
    const status = await call('vs2015_solution_status', { sessionId: ideSessionId });
    assert.equal(status.debugger.mode, 'design');
    const proj = status.projects.find(p => path.resolve(p.fileName).toLowerCase() === path.resolve(fixture.project).toLowerCase());
    assert.ok(proj);

    const opened = await call('phone_session_open', {
      processId: context.phone.processId,
      expectedStartTimeUtc: context.phone.startTimeUtc,
      expectedVmId: context.phone.vmId,
      coreConDeviceId: context.phone.coreConDeviceId,
      localeId: context.phone.localeId,
      timeoutMs: 120000,
      ideBinding: {
        sessionId: ideSessionId,
        projectUniqueName: proj.uniqueName,
        targetPropertyName: context.targetPropertyName ?? 'Debug.DeviceId',
        scope: 'activeConfiguration',
      },
    });
    phoneSessionId = opened.phoneSessionId;

    const pIde = (toolName, args = {}, timeout = 120000) => call('phone_session_ide', { phoneSessionId, toolName, arguments: args }, timeout);
    const pIdeRaw = (toolName, args = {}, timeout = 120000) => raw('phone_session_ide', { phoneSessionId, toolName, arguments: args }, timeout);

    const buildJob = await pIde('vs2015_build_active', { action: 'build' }, 180000);
    for (;;) {
      const bs = await pIde('vs2015_build_status', { buildId: buildJob.buildId });
      if (bs.terminal) { assert.equal(bs.state, 'succeeded'); break; }
      await new Promise(r => setTimeout(r, 500));
    }
    const deployJob = await pIde('vs2015_project_build', { projectUniqueName: proj.uniqueName, action: 'deploy', expectedConfigurationToken: status.configurationToken }, 180000);
    for (;;) {
      const bs = await pIde('vs2015_build_status', { buildId: deployJob.buildId });
      if (bs.terminal) { assert.equal(bs.state, 'succeeded'); break; }
      await new Promise(r => setTimeout(r, 500));
    }

    await pIde('vs2015_ide_debug_breakpoints', { action: 'add', file: fixture.source, line: context.invokePauseLine ?? (fixture.breakpointLine + 2) });
    const go = await pIde('vs2015_ide_debug_control', { action: 'go' }, 150000);
    await pIde('vs2015_ide_debug_wait', { mode: 'run', afterSequence: go.afterSequence, timeoutMs: 120000 }, 130000);

    let paused;
    const taps = [context.tap, { x: context.tap.x, y: Math.max(0, context.tap.y - 40) }, { x: context.tap.x, y: context.tap.y + 30 }];
    for (let i = 0; i < taps.length; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 2500 : 3000));
      await call('phone_session_input', { phoneSessionId, action: 'tap', x: taps[i].x, y: taps[i].y });
      paused = await pIde('vs2015_ide_debug_wait', { mode: 'break', afterSequence: go.afterSequence, timeoutMs: 10000 });
      if (paused.reached) break;
    }
    assert.equal(paused?.reached, true, 'Guest breakpoint was not hit after tapping');

    const guestIdentity = await pIde('vs2015_ide_guest_app_identity', {
      pauseId: paused.pauseId,
      frameId: paused.currentFrame.frameId,
      includeProductId: true,
      evaluationTimeoutMs: 10000,
    });
    assert.equal(guestIdentity.applicationVerification, 'guest-matched');

    const firstTree = await pIde('vs2015_ide_xaml_tree', {
      pauseId: paused.pauseId,
      frameId: paused.currentFrame.frameId,
      maxDepth: 6,
      maxNodes: 48,
      queryTimeoutMs: 45000,
      evaluationTimeoutMs: 2500,
    }, 90000);
    assert.equal(firstTree.framework, 'winrt-xaml');
    const firstEditable = firstTree.nodes.find(n => n.automationId === 'EditableValue');
    const firstButton = firstTree.nodes.find(n => n.automationId === 'IncrementButton');
    const firstStack = firstTree.nodes.find(n => n.type === 'Windows.UI.Xaml.Controls.StackPanel');
    assert.ok(firstEditable && firstButton && firstStack, JSON.stringify(firstTree.nodes));

    // Subtree rooted at StackPanel retires firstTree's node IDs
    const subtree = await pIde('vs2015_ide_xaml_tree', {
      pauseId: firstTree.pauseId,
      frameId: paused.currentFrame.frameId,
      rootNodeId: firstStack.nodeId,
      maxDepth: 2,
      maxNodes: 20,
      queryTimeoutMs: 45000,
      evaluationTimeoutMs: 2500,
    }, 90000);
    assert.equal(subtree.parentRootNodeId, firstStack.nodeId);
    assert.equal(subtree.nodes[0].relativeDepth, 0);

    // Retired snapshot nodeId must be rejected
    const staleBeforeAction = await pIdeRaw('vs2015_ide_xaml_action', {
      pauseId: subtree.pauseId,
      frameId: paused.currentFrame.frameId,
      nodeId: firstButton.nodeId,
      action: 'invoke',
    });
    assert.equal(staleBeforeAction.isError, true);
    assert.equal(staleBeforeAction.structuredContent.error.code, 'STALE_XAML_NODE');

    const editableSub = subtree.nodes.find(n => n.automationId === 'EditableValue');
    assert.ok(editableSub);

    // Ordinary TextBox does not expose ValuePattern
    const noValuePattern = await pIdeRaw('vs2015_ide_xaml_action', {
      pauseId: subtree.pauseId,
      frameId: paused.currentFrame.frameId,
      nodeId: editableSub.nodeId,
      action: 'setValue',
      value: 'not-applied',
    });
    assert.equal(noValuePattern.isError, true);
    assert.equal(noValuePattern.structuredContent.error.code, 'XAML_PATTERN_UNAVAILABLE');

    const specialText = 'MCP "value" \\ 中文 | :';
    const textAction = await pIde('vs2015_ide_xaml_action', {
      pauseId: subtree.pauseId,
      frameId: paused.currentFrame.frameId,
      nodeId: editableSub.nodeId,
      action: 'setText',
      value: specialText,
      evaluationTimeoutMs: 3000,
    }, 60000);
    assert.equal(textAction.issued, true);
    assert.equal(textAction.confirmed, true);
    assert.equal(textAction.value, specialText);
    assert.equal(textAction.api, 'Windows.UI.Xaml.Controls.TextBox.Text');

    // Read fresh tree using new pauseId returned after ExecuteStatement
    const afterTextTree = await pIde('vs2015_ide_xaml_tree', {
      pauseId: textAction.pauseId,
      maxDepth: 6,
      maxNodes: 48,
      queryTimeoutMs: 45000,
      evaluationTimeoutMs: 2500,
    }, 90000);
    assert.equal(afterTextTree.nodes.find(n => n.automationId === 'EditableValue')?.text, specialText);

    const buttonNow = afterTextTree.nodes.find(n => n.automationId === 'IncrementButton');
    assert.ok(buttonNow);
    const invokeAction = await pIde('vs2015_ide_xaml_action', {
      pauseId: afterTextTree.pauseId,
      nodeId: buttonNow.nodeId,
      action: 'invoke',
      evaluationTimeoutMs: 3000,
    }, 60000);
    assert.equal(invokeAction.issued, true);
    assert.equal(invokeAction.api, 'InvokePattern.Invoke');

    // Pre-invoke button nodeId must be rejected now
    const staleAfterInvoke = await pIdeRaw('vs2015_ide_xaml_action', {
      pauseId: invokeAction.pauseId,
      nodeId: buttonNow.nodeId,
      action: 'invoke',
    });
    assert.equal(staleAfterInvoke.isError, true);
    assert.equal(staleAfterInvoke.structuredContent.error.code, 'STALE_XAML_NODE');

    const afterInvokeTree = await pIde('vs2015_ide_xaml_tree', {
      pauseId: invokeAction.pauseId,
      maxDepth: 6,
      maxNodes: 48,
      queryTimeoutMs: 45000,
      evaluationTimeoutMs: 2500,
    }, 90000);
    assert.equal(afterInvokeTree.nodes.find(n => n.automationId === 'StatusValue')?.text, 'Result: 44');

    // Resume and capture PNG screenshot
    await pIde('vs2015_ide_debug_control', { action: 'go' }, 150000);
    await new Promise(r => setTimeout(r, 1200));
    const pngPath = path.join(artifacts, 'xaml-result44.png');
    const shot = await raw('phone_session_screenshot', { phoneSessionId, path: pngPath, includeImage: true });
    assert.equal(shot.isError, false, JSON.stringify(shot));
    assert.ok(shot.content.some(item => item.type === 'image' && item.mimeType === 'image/png'));
    assert.equal((await readFile(pngPath)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, pngPath, text: specialText, status: 'Result: 44' }, null, 2));
  } finally {
    if (phoneSessionId) await raw('phone_session_close', { phoneSessionId }).catch(() => {});
    if (ideSessionId) {
      try {
        const st = await call('vs2015_ide_debug_state', { sessionId: ideSessionId });
        if (st.mode !== 'design') {
          await call('vs2015_ide_debug_control', { sessionId: ideSessionId, action: 'stop' });
          await call('vs2015_ide_debug_wait', { sessionId: ideSessionId, mode: 'design', timeoutMs: 30000 });
        }
      } catch {}
      await raw('vs2015_detach', { sessionId: ideSessionId }).catch(() => {});
    }
    await client.close().catch(() => {});
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ideDefinitions } from '../src/ide.mjs';
import { IdeBridgeClient } from '../src/ide-client.mjs';
import { PhoneSessionManager } from '../src/phone-session-manager.mjs';
import { phoneSessionErrorResult } from '../src/phone-session.mjs';

const product = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('XAML test helper timeout')); }, 120000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code) reject(new Error(`${stdout}\n${stderr}`.trim()));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}
const IDS = {
  session: '10000000-0000-4000-8000-000000000001',
  pause: '20000000-0000-4000-8000-000000000001',
  frame: '30000000-0000-4000-8000-000000000001',
  node: '40000000-0000-4000-8000-000000000001',
  vm: '50000000-0000-4000-8000-000000000001',
  device: '60000000-0000-4000-8000-000000000001',
};

test('XAML automation schemas validate arguments and scale tree query deadlines', async () => {
  const treeTool = ideDefinitions.find(t => t.name === 'vs2015_ide_xaml_tree');
  const actionTool = ideDefinitions.find(t => t.name === 'vs2015_ide_xaml_action');
  assert.ok(treeTool && actionTool);

  const parsedTree = treeTool.schema.parse({ sessionId: IDS.session, pauseId: IDS.pause, queryTimeoutMs: 60000 });
  assert.equal(parsedTree.timeoutMs, undefined);
  assert.equal(parsedTree.maxDepth, 8);
  assert.equal(parsedTree.maxNodes, 100);

  assert.throws(() => actionTool.schema.parse({ sessionId: IDS.session, pauseId: IDS.pause, nodeId: IDS.node, action: 'invoke', value: 'x' }));
  assert.throws(() => actionTool.schema.parse({ sessionId: IDS.session, pauseId: IDS.pause, nodeId: IDS.node, action: 'setValue' }));
  assert.throws(() => actionTool.schema.parse({ sessionId: IDS.session, pauseId: IDS.pause, nodeId: IDS.node, action: 'setText', value: 'bad\0text' }));
  assert.equal(actionTool.schema.parse({ sessionId: IDS.session, pauseId: IDS.pause, nodeId: IDS.node, action: 'setText', value: '' }).value, '');
  assert.equal(actionTool.schema.parse({ sessionId: IDS.session, pauseId: IDS.pause, nodeId: IDS.node, action: 'invoke' }).action, 'invoke');
});

test('XAML_ACTION_UNCONFIRMED preserves operationMayContinue and details across IdeBridgeClient and PhoneSession', async t => {
  class FakeBridgeProcess extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      let buf = '';
      this.stdin.on('data', chunk => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          this.stdout.write(JSON.stringify({
            id: req.id,
            error: {
              code: 'XAML_ACTION_UNCONFIRMED',
              message: 'The automation statement may have executed.',
              hresult: -2147467259,
              operationMayContinue: true,
              details: { issued: true, dispatchStarted: true, executionResultKnown: false, action: 'invoke', nodeId: IDS.node },
            },
          }) + '\n');
        }
      });
      queueMicrotask(() => this.stdout.write(JSON.stringify({ kind: 'ready', protocolVersion: 1 }) + '\n'));
    }
    kill() { this.exitCode = 0; this.emit('close', 0); }
  }

  const client = new IdeBridgeClient({ launch: async () => new FakeBridgeProcess() });
  t.after(() => client.stop());

  await assert.rejects(
    client.request('xamlAction', { sessionId: IDS.session, pauseId: IDS.pause, nodeId: IDS.node, action: 'invoke' }),
    err => err.code === 'XAML_ACTION_UNCONFIRMED' && err.operationMayContinue === true && err.backendError?.details?.issued === true,
  );

  // Also verify PhoneSessionManager + phoneSessionErrorResult preserve operationMayContinue and details for XAML_ACTION_UNCONFIRMED
  const stamp = '2026-11-18T01:02:03.1234567Z';
  const live = {
    status: { isOpen: true, fullName: 'C:\\f\\p.sln', ideLocaleId: 1033, configurationToken: 'c1', startupProjects: ['P.csproj'], projects: [{ uniqueName: 'P.csproj', fileName: 'C:\\f\\P.csproj' }] },
    manifest: { ideProcessId: 71, ideStartTimeUtc: stamp, ideLocaleId: 1033, solutionPath: 'C:\\f\\p.sln', projectPath: 'C:\\f\\P.csproj', projectUniqueName: 'P.csproj',
      manifestNamespace: 'http://schemas.microsoft.com/appx/2010/manifest', source: 'included-project-item-saved-disk', manifestPath: 'C:\\f\\Package.appxmanifest', manifestSha256: 'ab'.repeat(32), configurationToken: 'c1',
      packageIdentity: { name: 'pkg', publisher: 'CN=Test', version: '1.0.0.0' }, applications: [{ id: 'App', namespace: 'http://schemas.microsoft.com/appx/2010/manifest' }] },
    props: { activeConfiguration: { 'Debug.DeviceId': IDS.device }, project: {} },
  };
  let seenTreeTimeout;
  const xamlTreeDef = { ...ideDefinitions.find(d => d.name === 'vs2015_ide_xaml_tree'), run: async args => { seenTreeTimeout = args.timeoutMs; return { nodes: [] }; } };
  const xamlActionDef = { ...ideDefinitions.find(d => d.name === 'vs2015_ide_xaml_action'), run: async () => ({ error: { code: 'XAML_ACTION_UNCONFIRMED', message: 'uncertain', operationMayContinue: true, details: { issued: true, nodeId: IDS.node } } }) };
  const manager = new PhoneSessionManager({
    clientFactory: () => ({
      identity: { processId: 81, startTimeUtc: stamp, vmId: IDS.vm, vmName: 'Emu', executable: 'C:\\XDE\\8.1\\XDE.exe', directory: 'C:\\XDE\\8.1' },
      mapping: { matched: true, method: 'sdk-endpoint-pair', deviceId: IDS.device, localeId: 1033, vmId: IDS.vm, processId: 81, hostAddress: '169.254.1.1', guestAddress: '169.254.1.2' },
      async request(op) {
        if (op === 'open' || op === 'identity') return { sessionId: 'b81', identity: this.identity, crossChannelMapping: this.mapping };
        if (op === 'close') return { sessionId: 'b81', closed: true, vmClosed: false, cleanupWarnings: [], unreleasedKeys: [] };
        return {};
      },
      async stop() { return { cleanupStatus: 'completed' }; },
    }),
    ideInvoke: async (op, args) => {
      if (op === 'solutionStatus') return structuredClone(live.status);
      if (op === 'projectAppIdentity') return structuredClone(live.manifest);
      if (op === 'projectProperties') {
        const map = live.props[args.scope];
        return args.propertyName ? { properties: [{ name: args.propertyName, value: map[args.propertyName], available: true }] } : { properties: Object.keys(map).map(name => ({ name, valueRead: false })), truncated: false };
      }
      throw new Error('Unexpected op: ' + op);
    },
    ideDefinitions: [xamlTreeDef, xamlActionDef],
  });
  t.after(() => manager.stopAll());
  const opened = await manager.open({ processId: 81, expectedStartTimeUtc: stamp, expectedVmId: IDS.vm, coreConDeviceId: IDS.device, localeId: 1033, ideBinding: { sessionId: IDS.session, projectUniqueName: 'P.csproj', targetPropertyName: 'Debug.DeviceId' } });

  await manager.ide({ phoneSessionId: opened.phoneSessionId, toolName: 'vs2015_ide_xaml_tree', arguments: { pauseId: IDS.pause, queryTimeoutMs: 45000 } });
  assert.equal(seenTreeTimeout, 55000);

  let caught;
  try {
    await manager.ide({ phoneSessionId: opened.phoneSessionId, toolName: 'vs2015_ide_xaml_action', arguments: { pauseId: IDS.pause, nodeId: IDS.node, action: 'invoke' } });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  const formatted = phoneSessionErrorResult(caught);
  assert.equal(formatted.error.code, 'XAML_ACTION_UNCONFIRMED');
  assert.equal(formatted.error.operationMayContinue, true);
  assert.equal(formatted.error.details.issued, true);
  assert.equal(formatted.error.details.nodeId, IDS.node);
});

test('compiled XamlAutomation helpers decode literals, base64, integers and reject malformed payloads', { skip: process.platform !== 'win32', timeout: 180000 }, async () => {
  const pwsh = process.env.VS2015_MCP_PWSH ?? 'pwsh.exe';
  const buildOut = await run(pwsh, ['-NoProfile', '-File', path.join(product, 'scripts/Build-IdeBridge.ps1')], '{}');
  const built = JSON.parse(buildOut.replace(/^\uFEFF/, ''));
  assert.ok(built.executablePath, built.error?.message);

  const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows';
  const stdout = await run(
    path.join(windows, 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(product, 'test/fixtures/Test-XamlAutomation.ps1'), '-BridgePath', built.executablePath],
  );
  const res = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  assert.ok(res.passed >= 26, JSON.stringify(res));
});

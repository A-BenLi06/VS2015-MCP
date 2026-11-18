import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const selected = [['Win10M', process.env.VS2015_TEST_WIN10M_CONTEXT], ['WP8.1', process.env.VS2015_TEST_WP81_CONTEXT]].filter(([, file]) => file);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (root, file) => { const rel = path.relative(path.resolve(root), path.resolve(file)); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const startToken = value => { const m = /^(.+T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(value); assert.ok(m, 'Fixture timestamps must be UTC'); return m[1] + '.' + (m[2] ?? '').padEnd(7, '0') + 'Z'; };

test('owned native MCP PhoneSession bindings and independent WP8.1/Win10 SDK controllers', {
  skip: process.platform !== 'win32' || !selected.length, timeout: 900000,
}, async t => {
  const repo = process.env.VS2015_TEST_MCP_REPO ? path.resolve(process.env.VS2015_TEST_MCP_REPO) : fileURLToPath(new URL('../../', import.meta.url));
  const server = path.join(repo, 'src', 'server.mjs');
  assert.equal((await stat(server)).isFile(), true);
  const fixtures = [];
  for (const [platform, contextFile] of selected) {
    assert.ok(within(os.tmpdir(), contextFile), 'Explicit context must be in TEMP');
    const context = JSON.parse(await readFile(path.resolve(contextFile), 'utf8'));
    assert.ok(within(os.tmpdir(), context.fixtureManifest), 'Manifest must be in TEMP');
    const fixture = JSON.parse(await readFile(path.resolve(context.fixtureManifest), 'utf8'));
    assert.ok(within(os.tmpdir(), fixture.root), 'An isolated generated fixture is required');
    assert.ok(within(fixture.root, context.fixtureManifest));
    for (const field of ['source', 'project', 'solution']) assert.ok(within(fixture.root, fixture[field]));
    assert.match(await readFile(fixture.source, 'utf8'), /MCP_BREAKPOINT/);
    assert.ok((await readFile(fixture.project, 'utf8')).toLowerCase().includes(fixture.projectGuid.toLowerCase()));
    assert.ok(Number.isInteger(fixture.ideProcessId) && fixture.ideStartTimeUtc);
    const phone = context.phone;
    assert.ok(Number.isInteger(phone?.processId) && phone.startTimeUtc && phone.vmId && phone.vmName && phone.executable && phone.coreConDeviceId && Number.isInteger(phone.localeId));
    assert.equal(phone.fixtureProductId.toLowerCase(), fixture.productId.toLowerCase());
    assert.ok(context.display?.width > 0 && context.display?.height > 0);
    fixtures.push({ platform, fixture, phone, context });
  }
  assert.equal(new Set(fixtures.map(f => f.phone.vmId.toLowerCase())).size, fixtures.length);
  assert.equal(new Set(fixtures.map(f => f.fixture.ideProcessId)).size, fixtures.length);
  const artifacts = await mkdtemp(path.join(fixtures[0].fixture.root, 'session-mcp-'));
  t.diagnostic('Artifacts: ' + artifacts);
  const records = [], cleanupErrors = [], attached = new Set(), openedIds = new Set();
  let failure;
  const client = new Client({ name: 'native-phone-session-mcp-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd: repo, env: { ...process.env } }));
  const call = async (name, args = {}, cleanup = false) => {
    const start = Date.now();
    const response = await client.callTool({ name, arguments: args }, { timeout: 360000, ...(cleanup ? {} : { signal: t.signal }) });
    const result = response.structuredContent;
    records.push({ name, args, timestampUtc: new Date().toISOString(), elapsedMs: Date.now() - start, result, isError: response.isError });
    await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(records, null, 2));
    t.diagnostic(name + ': ' + (Date.now() - start) + 'ms ' + (response.isError ? 'ERROR' : 'ok'));
    assert.equal(response.isError, false, JSON.stringify(result));
    assert.ok(result && typeof result === 'object');
    return result;
  };
  const privateHandle = result => {
    assert.equal(Object.hasOwn(result, 'sessionId'), false, 'SDK handle must remain private');
    assert.equal(Object.hasOwn(result, 'backendId'), false);
    assert.match(result.phoneSessionId, /^[a-f0-9-]{36}$/i);
    assert.equal(result.applicationVerification, 'project-only');
  };
  const observeIde = async item => {
    const { fixture, phone } = item;
    item.ideSessionId = (await call('vs2015_attach', { processId: fixture.ideProcessId, expectedStartTimeUtc: fixture.ideStartTimeUtc, timeoutMs: 120000 })).sessionId;
    attached.add(item.ideSessionId);
    const status = await call('vs2015_solution_status', { sessionId: item.ideSessionId, timeoutMs: 60000 });
    assert.equal(samePath(status.fullName, fixture.solution), true);
    assert.equal(status.ideLocaleId, phone.localeId);
    assert.equal(status.debugger.mode, 'design', 'Do not take over an active debugger');
    assert.notEqual(status.buildState, 'vsBuildStateInProgress');
    const configs = await call('vs2015_solution_configurations', { sessionId: item.ideSessionId, timeoutMs: 60000 });
    assert.equal(configs.configurationToken, status.configurationToken);
    assert.ok(configs.configurations.some(pair => pair.name === status.activeConfiguration && pair.platform === status.activePlatform));
    const projects = status.projects.filter(project => samePath(project.fileName, fixture.project));
    assert.equal(projects.length, 1); item.projectUniqueName = projects[0].uniqueName;
    assert.deepEqual(status.startupProjects, [item.projectUniqueName]);
    const metadata = await call('vs2015_project_properties', { sessionId: item.ideSessionId, projectUniqueName: item.projectUniqueName, scope: 'activeConfiguration', limit: 500, timeoutMs: 60000 });
    item.targetPropertyName = item.context.ideBinding?.targetPropertyName ?? 'Debug.DeviceId';
    assert.equal(metadata.truncated, false);
    assert.ok(metadata.properties.some(p => p.name === item.targetPropertyName));
    assert.ok(metadata.properties.every(p => p.valueRead === false && !Object.hasOwn(p, 'value')));
    const target = await call('vs2015_project_properties', { sessionId: item.ideSessionId, projectUniqueName: item.projectUniqueName, scope: 'activeConfiguration', propertyName: item.targetPropertyName, timeoutMs: 60000 });
    assert.equal(target.properties.find(p => p.available)?.value.toLowerCase(), phone.coreConDeviceId.toLowerCase());
    item.app = await call('vs2015_project_app_identity', { sessionId: item.ideSessionId, projectUniqueName: item.projectUniqueName, timeoutMs: 60000 });
    assert.equal(item.app.source, 'included-project-item-saved-disk');
    assert.equal(item.app.configurationToken, status.configurationToken);
    assert.equal(item.app.ideLocaleId, phone.localeId);
    assert.equal(samePath(item.app.solutionPath, fixture.solution), true);
    assert.equal(samePath(item.app.projectPath, fixture.project), true);
    assert.ok(within(fixture.root, item.app.manifestPath));
    assert.match(item.app.manifestSha256, /^[a-f0-9]{64}$/i);
    assert.equal(item.app.applications.length, 1);
    assert.equal(item.app.phoneIdentity.phoneProductId.toLowerCase(), fixture.productId.toLowerCase());
  };
  const open = async item => {
    const result = await call('phone_session_open', { processId: item.phone.processId, expectedStartTimeUtc: item.phone.startTimeUtc, expectedVmId: item.phone.vmId,
      coreConDeviceId: item.phone.coreConDeviceId, localeId: item.phone.localeId, timeoutMs: 120000,
      ideBinding: { sessionId: item.ideSessionId, projectUniqueName: item.projectUniqueName, targetPropertyName: item.targetPropertyName, scope: 'activeConfiguration',
        manifestPath: item.app.manifestPath, applicationId: item.app.applications[0].id } });
    openedIds.add(result.phoneSessionId);
    privateHandle(result); assert.notEqual(result.phoneSessionId, item.ideSessionId);
    assert.equal(result.identity.processId, item.phone.processId);
    assert.equal(result.identity.vmId.toLowerCase(), item.phone.vmId.toLowerCase());
    assert.equal(startToken(result.identity.startTimeUtc), startToken(item.phone.startTimeUtc));
    assert.equal(result.identity.vmName, item.phone.vmName);
    assert.equal(samePath(result.identity.executable, item.phone.executable), true);
    assert.equal(result.crossChannelMapping.matched, true);
    assert.equal(result.crossChannelMapping.method, 'sdk-endpoint-pair');
    assert.equal(result.crossChannelMapping.deviceId.toLowerCase(), item.phone.coreConDeviceId.toLowerCase());
    assert.equal(result.crossChannelMapping.localeId, item.phone.localeId);
    assert.equal(result.ideBinding.sessionId, item.ideSessionId);
    assert.equal(result.ideBinding.manifestSha256, item.app.manifestSha256);
    return result;
  };
  const status = async (item, session) => {
    const result = await call('phone_session_status', { phoneSessionId: session.phoneSessionId, timeoutMs: 60000 });
    privateHandle(result);
    assert.equal(result.identity.vmId.toLowerCase(), item.phone.vmId.toLowerCase());
    assert.equal(result.identity.processId, item.phone.processId);
    assert.equal(result.vmName, item.phone.vmName);
    assert.equal(result.shellReady, true); assert.equal(result.toolsReady, true);
    assert.equal(result.display.width, item.context.display.width); assert.equal(result.display.height, item.context.display.height);
    assert.equal(result.crossChannelMapping.matched, true); assert.deepEqual(result.heldKeys, []);
    return result;
  };
  const close = async (session, cleanup = false) => {
    const result = await call('phone_session_close', { phoneSessionId: session.phoneSessionId, timeoutMs: 60000 }, cleanup);
    openedIds.delete(session.phoneSessionId);
    assert.equal(result.closed, true); assert.equal(result.vmClosed, false);
    assert.deepEqual(result.unreleasedKeys, []); assert.deepEqual(result.cleanupWarnings, []);
    assert.equal(result.cleanupStatus, 'completed');
    return result;
  };
  try {
    for (const item of fixtures) {
      t.diagnostic('Individual ' + item.platform);
      await observeIde(item);
      const session = await open(item), observed = await status(item, session);
      const endpoint = await call('phone_session_endpoint', { phoneSessionId: session.phoneSessionId, timeoutMs: 60000 });
      privateHandle(endpoint);
      assert.ok(net.isIP(endpoint.hostAddress) && net.isIP(endpoint.guestAddress));
      assert.equal(endpoint.hostAddress, observed.crossChannelMapping.hostAddress); assert.equal(endpoint.guestAddress, observed.crossChannelMapping.guestAddress);
      const debug = await call('phone_session_ide', { phoneSessionId: session.phoneSessionId, timeoutMs: 60000, toolName: 'vs2015_ide_debug_state', arguments: { sessionId: item.ideSessionId } });
      assert.equal(debug.mode, 'design'); assert.equal(debug.applicationVerification, 'project-only');
      const borrowed = await call('phone_session_ide', { phoneSessionId: session.phoneSessionId, timeoutMs: 60000, toolName: 'vs2015_solution_status', arguments: {} });
      assert.equal(borrowed.sessionId, item.ideSessionId); assert.equal(samePath(borrowed.fullName, item.fixture.solution), true);
      const output = path.join(artifacts, item.platform.replace(/\W/g, '') + '-' + session.phoneSessionId + '.png');
      const image = await call('phone_session_screenshot', { phoneSessionId: session.phoneSessionId, timeoutMs: 60000, path: output, includeImage: false });
      privateHandle(image); assert.equal(samePath(image.path, output), true);
      assert.equal((await readFile(image.path)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(image.width, item.context.display.width); assert.equal(image.height, item.context.display.height);
      await close(session);
      assert.equal((await call('vs2015_ide_debug_state', { sessionId: item.ideSessionId, timeoutMs: 60000 })).mode, 'design');
    }
    if (fixtures.length > 1) {
      t.diagnostic('Simultaneous independent SDK controllers');
      const sessions = [];
      for (const item of fixtures) sessions.push(await open(item));
      assert.equal(new Set(sessions.map(s => s.phoneSessionId)).size, fixtures.length);
      assert.equal(new Set(sessions.map(s => s.identity.directory.toLowerCase())).size, fixtures.length);
      for (let i = 0; i < fixtures.length; i++) await status(fixtures[i], sessions[i]);
      await close(sessions[0]);
      for (let i = 1; i < fixtures.length; i++) { await status(fixtures[i], sessions[i]); await close(sessions[i]); }
    }
  } catch (error) { failure = error; throw error; }
  finally {
    for (const phoneSessionId of openedIds) try { await close({ phoneSessionId }, true); } catch (error) { cleanupErrors.push({ phoneSessionId, message: error.message }); }
    for (const sessionId of attached) try {
      assert.equal((await call('vs2015_ide_debug_state', { sessionId, timeoutMs: 60000 }, true)).mode, 'design');
      const detached = await call('vs2015_detach', { sessionId, timeoutMs: 60000 }, true);
      assert.equal(detached.detached, true); assert.equal(detached.ideClosed, false);
    } catch (error) { cleanupErrors.push({ sessionId, message: error.message }); }
    await client.close();
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: !failure && !cleanupErrors.length, failure: failure?.message, cleanupErrors, platforms: fixtures.map(f => f.platform) }, null, 2));
    if (!failure) assert.deepEqual(cleanupErrors, []);
  }
});

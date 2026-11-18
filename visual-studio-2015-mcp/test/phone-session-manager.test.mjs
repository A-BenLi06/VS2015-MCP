import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { PhoneSessionManager, utcIdentityTicks } from '../src/phone-session-manager.mjs';
import { createPhoneSessionDefinitions, formatPhoneSessionScreenshot, phoneSessionErrorResult } from '../src/phone-session.mjs';

const IDS = { vm: '10000000-0000-4000-8000-000000000001', vm2: '10000000-0000-4000-8000-000000000002', device: '20000000-0000-4000-8000-000000000001',
  device2: '20000000-0000-4000-8000-000000000002', ide: '30000000-0000-4000-8000-000000000001', otherIde: '30000000-0000-4000-8000-000000000002',
  product: '40000000-0000-4000-8000-000000000001' };
const stamp = '2026-11-18T01:02:03.1234567Z';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Condition not observed'); };
function fixture(options = {}) {
  const log = [], clients = [], dispatches = [];
  const live = {
    status: { isOpen: true, fullName: 'C:\\fixture\\phone.sln', ideLocaleId: 1033, configurationToken: 'cfg-one', startupProjects: ['Phone.csproj'],
      projects: [{ uniqueName: 'Phone.csproj', fileName: 'C:\\fixture\\Phone.csproj' }] },
    manifest: { ideProcessId: 71, ideStartTimeUtc: stamp, ideLocaleId: 1033, solutionPath: 'C:\\fixture\\phone.sln', projectPath: 'C:\\fixture\\Phone.csproj', projectUniqueName: 'Phone.csproj',
      manifestNamespace: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10', source: 'included-project-item-saved-disk', manifestPath: 'C:\\fixture\\Package.appxmanifest', manifestSha256: 'ab'.repeat(32), configurationToken: 'cfg-one', packageIdentity: { name: 'actual-manifest-name', publisher: 'CN=Fixture', version: '1.0.0.0' },
      phoneIdentity: { namespace: 'http://schemas.microsoft.com/appx/2014/phone/manifest', phoneProductId: IDS.product, phonePublisherId: '00000000-0000-0000-0000-000000000000' }, applications: [{ id: 'App', namespace: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10' }] },
    properties: { activeConfiguration: { 'Debug.DeviceId': IDS.device, 'Debug.UseEmulator': true, 'Debug.UseSimulator': false }, project: { AssemblyName: 'Fixture', Guard: 'expected' } },
  };
  const input = { processId: 81, expectedStartTimeUtc: stamp, expectedVmId: IDS.vm, coreConDeviceId: IDS.device, localeId: 1033,
    ideBinding: { sessionId: IDS.ide, projectUniqueName: 'Phone.csproj', targetPropertyName: 'Debug.DeviceId' } };
  const clientFactory = ({ input: selected }) => {
    const identity = { processId: selected.processId, startTimeUtc: selected.expectedStartTimeUtc, vmId: selected.expectedVmId, vmName: 'Own emulator ' + selected.processId,
      executable: 'C:\\XDE\\' + (selected.processId === 81 ? '8.1' : '10.0') + '\\XDE.exe', directory: 'C:\\XDE\\' + (selected.processId === 81 ? '8.1' : '10.0') };
    const client = { identity, held: new Set(), calls: [], stopped: false, failNextIdentity: null, failInput: null, identityGate: null,
      mapping: { matched: true, method: 'sdk-endpoint-pair', deviceId: selected.coreConDeviceId, localeId: selected.localeId, vmId: identity.vmId, processId: identity.processId, hostAddress: '169.254.1.1', guestAddress: '169.254.1.2' },
      async request(operation, args, context) {
        log.push('sdk:' + operation); this.calls.push({ operation, args: structuredClone(args) });
        if (this.stopped) throw Object.assign(new Error('closed client'), { code: 'PHONE_BRIDGE_CLOSED' });
        if (operation === 'identity' && this.identityGate) await this.identityGate.promise;
        if (operation === 'identity' && this.failNextIdentity) { const error = this.failNextIdentity; this.failNextIdentity = null; throw error; }
        if (operation === 'open' || operation === 'identity') return { sessionId: 'backend-' + selected.processId, identity: structuredClone(this.identity), crossChannelMapping: structuredClone(this.mapping) };
        if (['tap', 'text', 'key'].includes(operation) && this.failInput) throw this.failInput;
        if (operation === 'key') for (const key of args.keys) { if (args.mode === 'Press') this.held.add(key); else this.held.delete(key); }
        if (operation === 'close') { this.held.clear(); return { sessionId: 'backend-' + selected.processId, closed: true, vmClosed: false, cleanupWarnings: this.closeWarnings ?? [], unreleasedKeys: this.unreleased ?? [] }; }
        return { sessionId: 'backend-' + selected.processId, operation, heldKeys: [...this.held], path: args.path };
      },
      async stop() { this.stopped = true; this.releasedOnStop = [...this.held]; this.held.clear(); return { cleanupStatus: 'completed', forcedTermination: false }; },
    };
    clients.push(client); return client;
  };
  const ideInvoke = async (operation, args, ctx) => {
    log.push('ide:' + operation);
    assert.equal(args.sessionId, IDS.ide);
    if (operation === 'projectAppIdentity' && live.gate) { live.gateReached = true; await live.gate.promise; }
    if (operation === 'solutionStatus') return structuredClone(live.status);
    if (operation === 'projectAppIdentity') return structuredClone(live.manifest);
    if (operation === 'projectProperties') {
      const properties = live.properties[args.scope];
      if (args.propertyName) {
        if (!Object.hasOwn(properties, args.propertyName)) throw Object.assign(new Error('not exposed'), { code: 'PROPERTY_NOT_FOUND' });
        return { properties: [{ name: args.propertyName, value: properties[args.propertyName], available: true }] };
      }
      return { properties: Object.keys(properties).map(name => ({ name, valueRead: false })), truncated: false };
    }
    throw new Error('Unexpected validation operation: ' + operation);
  };
  const phoneGoGuard = z.object({ configurationToken: z.string(), projectUniqueName: z.string(), targetPropertyName: z.string(), scope: z.enum(['project','activeConfiguration']), deviceId: z.guid(), manifestPath: z.string(), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/i), applicationId: z.string(), targetGuards: z.array(z.object({name:z.string(),scope:z.enum(['project','activeConfiguration']),value:z.union([z.string(),z.number(),z.boolean(),z.null()])}).strict()) }).strict();
  const definitions = [
    { name: 'vs2015_ide_debug_control', schema: z.object({ sessionId: z.guid(), action: z.enum(['go', 'stop']), timeoutMs: z.number().default(15000), expectedPhoneBinding: phoneGoGuard.optional() }), run: async args => { dispatches.push(args); log.push('forward:go'); return { issued: true, action: args.action }; } },
    { name: 'vs2015_project_build', schema: z.object({ sessionId: z.guid(), projectUniqueName: z.string(), action: z.enum(['build', 'deploy']), expectedConfigurationToken: z.string() }), run: async args => { dispatches.push(args); return { started: true }; } },
  ];
  const manager = new PhoneSessionManager({ clientFactory, ideInvoke, ideDefinitions: definitions, ...options });
  return { manager, input, live, clients, log, dispatches, definitions };
}
async function opened(t, options) { const f = fixture(options); t.after(() => f.manager.stopAll()); f.open = await f.manager.open(f.input); return f; }

test('opaque session pins the actual SDK and included manifest, never caller product IDs', async t => {
  const f = fixture(); t.after(() => f.manager.stopAll());
  const result = await f.manager.open({ ...f.input, productId: 'untrusted', ideBinding: { ...f.input.ideBinding, productId: 'untrusted' } });
  assert.equal(result.applicationVerification, 'project-only'); assert.equal(result.ideBinding.phoneIdentity.phoneProductId, IDS.product);
  assert.equal(Object.hasOwn(result, 'sessionId'), false); assert.notEqual(result.phoneSessionId, 'backend-81');
  await f.manager.input({ phoneSessionId: result.phoneSessionId, action: 'tap', x: 1, y: 2, sessionId: 'attacker', processId: 999 });
  assert.deepEqual(f.clients[0].calls.at(-1).args, { x: 1, y: 2, sessionId: 'backend-81' });
});

test('100 ns UTC identities normalize offsets without losing a tick', () => {
  assert.equal(utcIdentityTicks(stamp), utcIdentityTicks('2026-11-18T09:02:03.1234567+08:00'));
  assert.notEqual(utcIdentityTicks(stamp), utcIdentityTicks('2026-11-18T01:02:03.1234568Z'));
});

for (const [name, mutate, code] of [
  ['target GUID', f => { f.live.properties.activeConfiguration['Debug.DeviceId'] = IDS.device2; }, 'PHONE_IDE_TARGET_CHANGED'],
  ['IDE locale', f => { f.live.status.ideLocaleId = 2052; }, 'PHONE_IDE_LOCALE_MISMATCH'],
  ['configuration token', f => { f.live.status.configurationToken = 'cfg-two'; f.live.manifest.configurationToken = 'cfg-two'; }, 'PHONE_IDE_BINDING_CHANGED'],
  ['saved manifest hash', f => { f.live.manifest.manifestSha256 = 'cd'.repeat(32); }, 'PHONE_IDE_BINDING_CHANGED'],
  ['startup project', f => { f.live.status.startupProjects = ['Other.csproj']; }, 'PHONE_IDE_STARTUP_CHANGED'],
  ['multiple startup projects', f => { f.live.status.startupProjects.push('Other.csproj'); }, 'PHONE_IDE_STARTUP_CHANGED'],
  ['solution path', f => { f.live.status.fullName = 'C:\\other.sln'; f.live.manifest.solutionPath = 'C:\\other.sln'; }, 'PHONE_IDE_BINDING_CHANGED'],
  ['project path', f => { f.live.status.projects[0].fileName = 'C:\\other.csproj'; f.live.manifest.projectPath = 'C:\\other.csproj'; }, 'PHONE_IDE_BINDING_CHANGED'],
  ['emulator routing', f => { f.live.properties.activeConfiguration['Debug.UseEmulator'] = false; }, 'PHONE_IDE_TARGET_GUARD_CHANGED'],
  ['simulator routing', f => { f.live.properties.activeConfiguration['Debug.UseSimulator'] = true; }, 'PHONE_IDE_TARGET_GUARD_CHANGED'],
]) test('drift in ' + name + ' prevents input and forwarded IDE mutation', async t => {
  const f = await opened(t); mutate(f);
  await assert.rejects(f.manager.input({ phoneSessionId: f.open.phoneSessionId, action: 'tap', x: 1, y: 2 }), { code });
  await assert.rejects(f.manager.ide({ phoneSessionId: f.open.phoneSessionId, toolName: 'vs2015_ide_debug_control', arguments: { action: 'go' } }), { code });
  assert.equal(f.clients[0].calls.some(call => call.operation === 'tap'), false); assert.equal(f.dispatches.length, 0);
});

test('explicit discovered target guard is rechecked and close bypasses unavailable IDE', async t => {
  const f = fixture(); t.after(() => f.manager.stopAll());
  f.input.ideBinding.targetGuards = [{ name: 'Guard', scope: 'project', value: 'expected' }];
  const open = await f.manager.open(f.input); f.live.properties.project.Guard = 'changed';
  await assert.rejects(f.manager.endpoint({ phoneSessionId: open.phoneSessionId }), { code: 'PHONE_IDE_TARGET_GUARD_CHANGED' });
  f.live.status.isOpen = false; const prior = f.log.length;
  const result = await f.manager.close({ phoneSessionId: open.phoneSessionId });
  assert.equal(result.closed, true); assert.equal(result.vmClosed, false); assert.deepEqual(f.log.slice(prior), ['sdk:close']); assert.equal(f.clients[0].stopped, true);
});

test('SDK VM identity reset invalidates the record before input', async t => {
  const f = await opened(t); f.clients[0].identity.vmId = IDS.vm2;
  await assert.rejects(f.manager.input({ phoneSessionId: f.open.phoneSessionId, action: 'tap', x: 1, y: 2 }), { code: 'PHONE_TARGET_CHANGED' });
  const count = f.clients[0].calls.length;
  await assert.rejects(f.manager.status({ phoneSessionId: f.open.phoneSessionId }), { code: 'PHONE_SESSION_INVALID' });
  assert.equal(f.clients[0].calls.length, count);
});

test('one-tick process reuse and SDK executable drift are rejected', async t => {
  for (const mutate of [client => { client.identity.startTimeUtc = '2026-11-18T01:02:03.1234568Z'; }, client => { client.identity.executable = 'C:\\XDE\\other\\XDE.exe'; }]) {
    const f = await opened(t); mutate(f.clients[0]);
    await assert.rejects(f.manager.status({ phoneSessionId: f.open.phoneSessionId }), { code: 'PHONE_TARGET_CHANGED' });
  }
});

test('bridge reset is never replayed or reconnected, including close cleanup', async t => {
  const f = await opened(t); f.clients[0].failNextIdentity = Object.assign(new Error('controller reset'), { code: 'PHONE_BRIDGE_RESET' });
  await assert.rejects(f.manager.status({ phoneSessionId: f.open.phoneSessionId }), { code: 'PHONE_BRIDGE_RESET' });
  await assert.rejects(f.manager.status({ phoneSessionId: f.open.phoneSessionId }), { code: 'PHONE_SESSION_INVALID' });
  await f.manager.close({ phoneSessionId: f.open.phoneSessionId });
  assert.deepEqual(f.clients[0].calls.map(call => call.operation), ['open', 'identity']); assert.equal(f.clients.length, 1); assert.equal(f.clients[0].stopped, true);
});

test('cross-channel proof is required and refreshed, independent of display names', async t => {
  const f = await opened(t); f.clients[0].mapping.matched = false;
  await assert.rejects(f.manager.status({ phoneSessionId: f.open.phoneSessionId }), { code: 'PHONE_MAPPING_INVALID' });
  const g = fixture({ clientFactory: () => ({ request: async () => ({ sessionId: 'sdk', identity: { processId: 81, startTimeUtc: stamp, vmId: IDS.vm, vmName: 'same display name', executable: 'C:\\XDE.exe', directory: 'C:\\' } }), stop: async () => ({ cleanupStatus: 'completed' }) }) });
  t.after(() => g.manager.stopAll()); await assert.rejects(g.manager.open(g.input), { code: 'PHONE_MAPPING_INVALID' }); assert.equal(g.manager.records.size, 0);
});

test('different SDK VMs always get different clients and private handles', async t => {
  const f = await opened(t); const second = await f.manager.open({ ...f.input, processId: 82, expectedVmId: IDS.vm2, coreConDeviceId: IDS.device2, ideBinding: undefined });
  await f.manager.input({ phoneSessionId: second.phoneSessionId, action: 'key', keys: ['ShiftKey'], mode: 'Press' });
  assert.equal(f.clients.length, 2); assert.notEqual(f.clients[0].identity.directory, f.clients[1].identity.directory);
  assert.deepEqual([...f.clients[0].held], []); assert.deepEqual([...f.clients[1].held], ['ShiftKey']);
  await f.manager.close({ phoneSessionId: f.open.phoneSessionId }); assert.equal(f.clients[1].stopped, false);
});

test('IDE proxy applies original schema, fixes session and forbids target/configuration routing changes', async t => {
  const f = await opened(t), phoneSessionId = f.open.phoneSessionId;
  for (const toolName of ['vs2015_detach', 'vs2015_solution_configure', 'vs2015_project_property_set', 'vs2015_open_solution'])
    await assert.rejects(f.manager.ide({ phoneSessionId, toolName, arguments: {} }), { code: 'PHONE_IDE_TOOL_FORBIDDEN' });
  await assert.rejects(f.manager.ide({ phoneSessionId, toolName: 'vs2015_ide_debug_control', arguments: { sessionId: IDS.otherIde, action: 'go' } }), { code: 'PHONE_IDE_SESSION_CONFLICT' });
  await assert.rejects(f.manager.ide({ phoneSessionId, toolName: 'vs2015_ide_debug_control', arguments: { action: 'arbitrary-command' } }), z.ZodError);
  await assert.rejects(f.manager.ide({ phoneSessionId, toolName: 'vs2015_project_build', arguments: { projectUniqueName: 'Other.csproj', action: 'deploy', expectedConfigurationToken: 'cfg-one' } }), { code: 'PHONE_IDE_PROJECT_CONFLICT' });
  const result = await f.manager.ide({ phoneSessionId, toolName: 'vs2015_ide_debug_control', arguments: { action: 'go' } });
  assert.equal(result.issued, true); assert.equal(result.applicationVerification, 'project-only'); assert.equal(f.dispatches[0].sessionId, IDS.ide);
});

test('record queue covers validation plus dispatch so another call cannot interleave', async t => {
  const f = await opened(t); f.log.length = 0; f.live.gate = defer();
  const first = f.manager.input({ phoneSessionId: f.open.phoneSessionId, action: 'tap', x: 1, y: 1 }); await until(() => f.live.gateReached);
  const second = f.manager.input({ phoneSessionId: f.open.phoneSessionId, action: 'tap', x: 2, y: 2 });
  assert.equal(f.log.filter(item => item === 'sdk:identity').length, 1); f.live.gate.resolve(); await Promise.all([first, second]);
  const firstTap = f.log.indexOf('sdk:tap'), secondIdentity = f.log.indexOf('sdk:identity', 1);
  assert.ok(firstTap >= 0 && secondIdentity > firstTap); assert.deepEqual(f.clients[0].calls.filter(call => call.operation === 'tap').map(call => call.args.x), [1, 2]);
});

test('cancelled queued work never dispatches after earlier validation finishes', async t => {
  const f = await opened(t); f.live.gate = defer(); const first = f.manager.status({ phoneSessionId: f.open.phoneSessionId }); await until(() => f.live.gateReached);
  const abort = new AbortController(); const second = f.manager.input({ phoneSessionId: f.open.phoneSessionId, action: 'tap', x: 3, y: 3 }, { signal: abort.signal });
  abort.abort(); f.live.gate.resolve(); await first; await assert.rejects(second, { code: 'PHONE_SESSION_CANCELLED', operationMayContinue: false });
  assert.equal(f.clients[0].calls.some(call => call.operation === 'tap'), false);
});

test('opening slots are bounded and stopAll prevents a late SDK dispatch', async () => {
  const f = fixture({ maxSessions: 1 }); f.live.gate = defer();
  const pending = f.manager.open(f.input); await until(() => f.live.gateReached);
  await assert.rejects(f.manager.open({ ...f.input, processId: 82, expectedVmId: IDS.vm2 }), { code: 'PHONE_SESSION_LIMIT' });
  await f.manager.stopAll(); f.live.gate.resolve(); await assert.rejects(pending, { code: 'PHONE_SESSION_CLOSED' });
  assert.equal(f.clients[0].calls.length, 0); assert.equal(f.clients[0].stopped, true);
});

test('server disconnect releases held keys through each original client and cancels validation work', async t => {
  const f = await opened(t); await f.manager.input({ phoneSessionId: f.open.phoneSessionId, action: 'key', keys: ['ControlKey'], mode: 'Press' });
  f.live.gate = defer(); const pending = f.manager.input({ phoneSessionId: f.open.phoneSessionId, action: 'tap', x: 1, y: 1 }); await until(() => f.live.gateReached);
  await f.manager.stopAll(); f.live.gate.resolve(); await assert.rejects(pending, { code: 'PHONE_SESSION_CLOSED' });
  assert.deepEqual(f.clients[0].releasedOnStop, ['ControlKey']); assert.equal(f.clients[0].calls.some(call => call.operation === 'tap'), false);
});

test('uncertain input failure is explicit and never automatically retried', async t => {
  const f = await opened(t); f.clients[0].failInput = new Error('SDK threw after dispatch');
  await assert.rejects(f.manager.input({ phoneSessionId: f.open.phoneSessionId, action: 'tap', x: 1, y: 2 }), { operationMayContinue: true });
  assert.equal(f.clients[0].calls.filter(call => call.operation === 'tap').length, 1);
});

test('close reports unreleased keys honestly even when controller exit was clean', async t => {
  const f = await opened(t); f.clients[0].unreleased = ['ShiftKey'];
  const result = await f.manager.close({ phoneSessionId: f.open.phoneSessionId }); assert.equal(result.cleanupStatus, 'unknown'); assert.deepEqual(result.unreleasedKeys, ['ShiftKey']);
});

test('MCP schemas require pinned identities and reject trusted caller product IDs', () => {
  const f = fixture(), defs = createPhoneSessionDefinitions(f.manager), open = defs.find(tool => tool.name === 'phone_session_open');
  assert.throws(() => open.schema.parse({ ...f.input, productId: IDS.product }));
  assert.throws(() => open.schema.parse({ ...f.input, coreConDeviceId: undefined, localeId: undefined }));
  assert.equal(open.schema.parse(f.input).ideBinding.scope, 'activeConfiguration');
  const error = phoneSessionErrorResult(Object.assign(new Error('uncertain'), { code: 'PHONE_BRIDGE_TIMEOUT', operationMayContinue: true, cleanupDetails: { shutdown: { cleanupStatus: 'unknown' } } }));
  assert.equal(error.error.operationMayContinue, true); assert.equal(error.error.cleanupDetails.shutdown.cleanupStatus, 'unknown');
});

test('screenshot formatter preserves image limit and handles errors without reading a path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phone-session-image-')), small = path.join(directory, 'small.png'), big = path.join(directory, 'big.png');
  await writeFile(small, Buffer.from('PNG')); await writeFile(big, Buffer.alloc(4194305));
  assert.equal((await formatPhoneSessionScreenshot({ path: small }, { includeImage: true })).content[1].type, 'image');
  const omitted = await formatPhoneSessionScreenshot({ path: big }, { includeImage: true }); assert.equal(omitted.content.length, 1); assert.match(omitted.structuredContent.imageOmitted, /4 MiB/);
  assert.equal((await formatPhoneSessionScreenshot({ error: { code: 'FAILED' } }, { includeImage: true })).isError, true);
});


test('idle controller reset is latched before request and close never launches another bridge', async t => {
  const f=fixture();t.after(()=>f.manager.stopAll());const original=f.manager.clientFactory;
  f.manager.clientFactory=options=>Object.assign(original(options),{child:{pid:123},ready:true});
  const opened=await f.manager.open(f.input);f.clients[0].child=null;f.clients[0].ready=false;
  await assert.rejects(f.manager.status({phoneSessionId:opened.phoneSessionId}),{code:'PHONE_BRIDGE_RESET'});
  await assert.rejects(f.manager.status({phoneSessionId:opened.phoneSessionId}),{code:'PHONE_SESSION_INVALID'});
  await f.manager.close({phoneSessionId:opened.phoneSessionId});
  assert.deepEqual(f.clients[0].calls.map(call=>call.operation),['open']);assert.equal(f.clients.length,1);
});

test('close after an idle crash skips stale SDK cleanup without reconnecting', async t=>{
  const f=fixture();t.after(()=>f.manager.stopAll());const original=f.manager.clientFactory;
  f.manager.clientFactory=options=>Object.assign(original(options),{child:{pid:123},ready:true});
  const opened=await f.manager.open(f.input);f.clients[0].child=null;f.clients[0].ready=false;
  await f.manager.close({phoneSessionId:opened.phoneSessionId});
  assert.deepEqual(f.clients[0].calls.map(call=>call.operation),['open']);assert.equal(f.clients[0].stopped,true);
});

test('close rejects queued and validating commands before any guest input dispatch', async t=>{
  const f=await opened(t);f.clients[0].identityGate=defer();
  const first=f.manager.input({phoneSessionId:f.open.phoneSessionId,action:'tap',x:1,y:1});
  await until(()=>f.clients[0].calls.some(call=>call.operation==='identity'));
  const second=f.manager.input({phoneSessionId:f.open.phoneSessionId,action:'tap',x:2,y:2});
  const rejectedFirst=assert.rejects(first,{code:'PHONE_SESSION_CLOSED'}),rejectedSecond=assert.rejects(second,{code:'PHONE_SESSION_CLOSED'});
  const closing=f.manager.close({phoneSessionId:f.open.phoneSessionId});f.clients[0].identityGate.resolve();
  await Promise.all([rejectedFirst,rejectedSecond,closing]);
  assert.equal(f.clients[0].calls.some(call=>call.operation==='tap'),false);assert.equal(f.clients[0].calls.at(-1).operation,'close');
});

test('already dispatched input response can drain before close without replay',async t=>{
  const f=await opened(t),gate=defer(),client=f.clients[0],request=client.request.bind(client);let issued=false;
  client.request=async(operation,args,ctx)=>{const result=await request(operation,args,ctx);if(operation==='tap'){issued=true;await gate.promise;}return result;};
  const active=f.manager.input({phoneSessionId:f.open.phoneSessionId,action:'tap',x:1,y:1});await until(()=>issued);
  const closing=f.manager.close({phoneSessionId:f.open.phoneSessionId});assert.equal(client.calls.some(call=>call.operation==='close'),false);
  gate.resolve();const result=await active;await closing;assert.equal(result.operation,'tap');assert.equal(client.calls.filter(call=>call.operation==='tap').length,1);
});

test('IDE forwarding inherits wrapper timeout and gives phone go a 120 second default',async t=>{
  const f=await opened(t),phoneSessionId=f.open.phoneSessionId;
  await f.manager.ide({phoneSessionId,toolName:'vs2015_ide_debug_control',arguments:{action:'go'}});assert.equal(f.dispatches.at(-1).timeoutMs,120000);
  await f.manager.ide({phoneSessionId,timeoutMs:45000,toolName:'vs2015_ide_debug_control',arguments:{action:'go'}});assert.equal(f.dispatches.at(-1).timeoutMs,45000);
  await f.manager.ide({phoneSessionId,timeoutMs:45000,toolName:'vs2015_ide_debug_control',arguments:{action:'go',timeoutMs:21000}});assert.equal(f.dispatches.at(-1).timeoutMs,21000);
  const definition=createPhoneSessionDefinitions(f.manager).find(tool=>tool.name==='phone_session_ide');
  assert.equal(definition.schema.parse({phoneSessionId,toolName:'vs2015_ide_debug_control',arguments:{action:'go'}}).timeoutMs,undefined);
});


test('included manifest source and actual namespace are mandatory for IDE binding',async t=>{
  for(const mutate of [f=>{f.live.manifest.manifestNamespace='urn:wrong';},f=>{f.live.manifest.source='caller-file';},f=>{f.live.manifest.phoneIdentity.namespace='urn:wrong';}]){
    const f=fixture();t.after(()=>f.manager.stopAll());mutate(f);await assert.rejects(f.manager.open(f.input),{code:'PHONE_IDE_APP_IDENTITY_INVALID'});assert.equal(f.clients[0].calls.length,0);
  }
});


test('Go forwards the exact server-derived phone guard through the existing schema',async t=>{
  const f=await opened(t);await f.manager.ide({phoneSessionId:f.open.phoneSessionId,toolName:'vs2015_ide_debug_control',arguments:{action:'go'}});
  assert.deepEqual(f.dispatches[0].expectedPhoneBinding,{configurationToken:'cfg-one',projectUniqueName:'Phone.csproj',targetPropertyName:'Debug.DeviceId',scope:'activeConfiguration',deviceId:IDS.device,manifestPath:'C:\\fixture\\Package.appxmanifest',manifestSha256:'ab'.repeat(32),applicationId:'App',targetGuards:[{name:'Debug.UseEmulator',scope:'activeConfiguration',value:true},{name:'Debug.UseSimulator',scope:'activeConfiguration',value:false}]});
});

test('caller cannot substitute a foreign target in the Go preflight guard',async t=>{
  const f=await opened(t),phoneSessionId=f.open.phoneSessionId;
  await f.manager.ide({phoneSessionId,toolName:'vs2015_ide_debug_control',arguments:{action:'go'}});
  const valid=structuredClone(f.dispatches[0].expectedPhoneBinding);f.dispatches.length=0;const foreign={...valid,deviceId:IDS.device2};
  await assert.rejects(f.manager.ide({phoneSessionId,toolName:'vs2015_ide_debug_control',arguments:{action:'go',expectedPhoneBinding:foreign}}),{code:'PHONE_IDE_GUARD_CONFLICT'});assert.equal(f.dispatches.length,0);
  await f.manager.ide({phoneSessionId,toolName:'vs2015_ide_debug_control',arguments:{action:'go',expectedPhoneBinding:valid}});assert.deepEqual(f.dispatches[0].expectedPhoneBinding,valid);assert.notEqual(f.dispatches[0].expectedPhoneBinding,valid);
});

test('Go fails closed if an older IDE schema strips the new guard field',async t=>{
  const f=await opened(t);f.definitions[0].schema=z.object({sessionId:z.guid(),action:z.enum(['go','stop']),timeoutMs:z.number().default(15000)});
  await assert.rejects(f.manager.ide({phoneSessionId:f.open.phoneSessionId,toolName:'vs2015_ide_debug_control',arguments:{action:'go'}}),{code:'PHONE_IDE_GUARD_UNSUPPORTED'});assert.equal(f.dispatches.length,0);
});

test('explicit SDK routing guards merge with discovery without duplicate Go assertions', async t => {
  const f = fixture(); t.after(() => f.manager.stopAll());
  f.input.ideBinding.targetGuards = [{ name: 'Debug.UseEmulator', scope: 'activeConfiguration', value: true }];
  const opened = await f.manager.open(f.input);
  await f.manager.ide({ phoneSessionId: opened.phoneSessionId, toolName: 'vs2015_ide_debug_control', arguments: { action: 'go' } });
  const guards = f.dispatches[0].expectedPhoneBinding.targetGuards;
  assert.equal(guards.length, 2);
  assert.equal(guards.filter(guard => guard.name === 'Debug.UseEmulator').length, 1);
});

test('conflicting or excessive target guard contracts fail before connecting to the SDK', async t => {
  const conflict = fixture(); t.after(() => conflict.manager.stopAll());
  conflict.input.ideBinding.targetGuards = [{ name: 'Debug.UseEmulator', scope: 'activeConfiguration', value: false }];
  await assert.rejects(conflict.manager.open(conflict.input), { code: 'PHONE_IDE_TARGET_GUARD_CONFLICT' });
  assert.equal(conflict.clients[0].calls.length, 0);
  const excess = fixture(); t.after(() => excess.manager.stopAll());
  excess.input.ideBinding.targetGuards = Array.from({ length: 32 }, (_, i) => ({ name: 'Guard' + i, scope: 'project', value: true }));
  await assert.rejects(excess.manager.open(excess.input), { code: 'PHONE_IDE_TARGET_GUARD_LIMIT' });
  assert.equal(excess.clients[0].calls.length, 0);
});

test('PhoneSession verifies paused guest application identity against bound manifest and rejects mismatches', async t => {
  const f = fixture(); t.after(() => f.manager.stopAll());
  let guestReply = {
    confirmed: true, status: 'observed', pauseId: IDS.ide, frameId: IDS.vm, programIdentityKey: 'prog-1',
    applicationIdentity: { packageName: 'actual-manifest-name', publisher: 'CN=Fixture', fullName: 'actual-manifest-name_1.0.0.0_x86__hash', applicationId: 'App', version: { major: 1, minor: 0, build: 0, revision: 0 } },
    rawProductId: { available: true, isValidValue: true, normalizedGuid: IDS.product },
  };
  const defs = [
    ...f.definitions,
    {
      name: 'vs2015_ide_guest_app_identity',
      schema: z.object({ sessionId: z.guid(), pauseId: z.guid(), frameId: z.guid(), includeProductId: z.boolean().default(true), evaluationTimeoutMs: z.number().int().min(100).max(10000).default(3000), timeoutMs: z.number().default(15000) }),
      run: async () => structuredClone(guestReply),
    },
  ];
  const phoneManager = new PhoneSessionManager({
    clientFactory: ({ input }) => ({
      identity: { processId: input.processId, startTimeUtc: input.expectedStartTimeUtc, vmId: input.expectedVmId, vmName: 'Own ' + input.processId, executable: 'C:\\XDE\\8.1\\XDE.exe', directory: 'C:\\XDE\\8.1' },
      mapping: { matched: true, method: 'sdk-endpoint-pair', deviceId: input.coreConDeviceId, localeId: input.localeId, vmId: input.expectedVmId, processId: input.processId, hostAddress: '169.254.1.1', guestAddress: '169.254.1.2' },
      async request(op) {
        if (op === 'open' || op === 'identity') return { sessionId: 'backend-guest', identity: this.identity, crossChannelMapping: this.mapping };
        if (op === 'close') return { sessionId: 'backend-guest', closed: true, vmClosed: false, cleanupWarnings: [], unreleasedKeys: [] };
        return { sessionId: 'backend-guest', operation: op, heldKeys: [] };
      },
      async stop() { return { cleanupStatus: 'completed', forcedTermination: false }; },
    }),
    ideInvoke: async (op, args) => {
      if (op === 'solutionStatus') return structuredClone(f.live.status);
      if (op === 'projectAppIdentity') return structuredClone(f.live.manifest);
      if (op === 'projectProperties') {
        const properties = f.live.properties[args.scope];
        return args.propertyName ? { properties: [{ name: args.propertyName, value: properties[args.propertyName], available: true }] } : { properties: Object.keys(properties).map(name => ({ name, valueRead: false })), truncated: false };
      }
      throw new Error('Unexpected op: ' + op);
    },
    ideDefinitions: defs,
  });
  t.after(() => phoneManager.stopAll());
  const session = await phoneManager.open(f.input);
  assert.equal(session.applicationVerification, 'project-only');

  const matched = await phoneManager.ide({ phoneSessionId: session.phoneSessionId, toolName: 'vs2015_ide_guest_app_identity', arguments: { pauseId: IDS.ide, frameId: IDS.vm } });
  assert.equal(matched.applicationVerification, 'guest-matched');
  assert.equal(matched.guestApplicationMatch.matched, true);
  assert.equal(matched.guestApplicationMatch.productIdVerified, true);

  // Subsequent non-identity calls stay project-only rather than claiming persistent guest identity across execution.
  const built = await phoneManager.ide({ phoneSessionId: session.phoneSessionId, toolName: 'vs2015_project_build', arguments: { projectUniqueName: 'Phone.csproj', action: 'build', expectedConfigurationToken: 'cfg-one' } });
  assert.equal(built.applicationVerification, 'project-only');

  const base = structuredClone(guestReply);
  guestReply = { confirmed: false, status: 'unconfirmed', applicationIdentity: null, rawProductId: null };
  const unconfirmed = await phoneManager.ide({ phoneSessionId: session.phoneSessionId, toolName: 'vs2015_ide_guest_app_identity', arguments: { pauseId: IDS.ide, frameId: IDS.vm } });
  assert.equal(unconfirmed.applicationVerification, 'unconfirmed');
  assert.equal(unconfirmed.guestApplicationMatch, null);

  for (const mutate of [
    reply => { reply.applicationIdentity.packageName = 'wrong.pkg'; },
    reply => { reply.applicationIdentity.publisher = 'CN=Other'; },
    reply => { reply.applicationIdentity.applicationId = 'OtherApp'; },
    reply => { reply.applicationIdentity.version.build = 99; },
    reply => { reply.rawProductId.normalizedGuid = IDS.vm2; },
  ]) {
    guestReply = structuredClone(base);
    mutate(guestReply);
    await assert.rejects(
      phoneManager.ide({ phoneSessionId: session.phoneSessionId, toolName: 'vs2015_ide_guest_app_identity', arguments: { pauseId: IDS.ide, frameId: IDS.vm } }),
      { code: 'PHONE_GUEST_APP_MISMATCH' },
    );
  }
});

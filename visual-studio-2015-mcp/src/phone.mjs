import * as z from 'zod/v4';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { invokeBackend } from './bridge.mjs';
import { asToolResult } from './tools.mjs';

const text = z.string().min(1).refine(s => !/[\0\r\n]/.test(s), 'NUL/line breaks are not allowed');
const argument = z.string().refine(s => !s.includes('\0'));
const common = { timeoutMs: z.number().int().min(1000).max(600000).default(120000), xdeRoots: z.array(text).optional() };
const processFields = { ...common, processId: z.number().int().positive() };
const deviceFields = { ...common, deviceId: z.guid(), localeId: z.number().int().min(0).max(65535).optional() };
const cliFields = { timeoutMs: z.number().int().min(100).max(3600000).default(120000),
  maxOutputChars: z.number().int().min(256).max(1048576).default(64000), toolPath: text.optional(),
  workingDirectory: text.optional(), encoding: text.optional(), dryRun: z.boolean().default(false) };
const cliNames = z.enum(['appdeploy', 'xapdeploy', 'winappdeploy']);
const absolute = (input, file) => path.resolve(input.workingDirectory ?? process.cwd(), file);

async function phone(input, action, ctx) {
  const response = await invokeBackend({ ...input, action, setupTimeoutMs: 0 },
    { ...ctx, script: 'Phone.ps1', desktopX86: true });
  return { ...response.result, ...(response.cleanupWarnings?.length ? { cleanupWarnings: response.cleanupWarnings } : {}) };
}

function cli(input, tool, args, ctx) {
  return invokeBackend({ ...input, tool, arguments: args, setupTimeoutMs: 0 }, { ...ctx, script: 'Invoke-PhoneCli.ps1' });
}

export function planPhoneDeployment(input) {
  if (input.platform === 'wp81') {
    if (input.action === 'devices') return { tool: 'appdeploy', arguments: ['/EnumerateDevices'] };
    if (!input.target) throw new Error('WP8.1 requires a target from AppDeployCmd /EnumerateDevices.');
    const appAction = ['launch', 'uninstall'].includes(input.action);
    const value = appAction ? input.productId : input.package;
    if (!value) throw new Error(appAction ? 'productId is required.' : 'package is required.');
    return { tool: 'appdeploy', arguments: [`/${input.action}`, appAction ? value : absolute(input, value), `/targetdevice:${input.target}`] };
  }
  if (input.action === 'devices') return { tool: 'winappdeploy', arguments: ['devices'] };
  if (Boolean(input.ip) === Boolean(input.guid)) throw new Error('Specify exactly one Windows 10 Mobile target: ip or guid.');
  const args = [input.action];
  if (['install', 'update'].includes(input.action)) {
    if (!input.package) throw new Error('package is required.');
    args.push('-file', absolute(input, input.package));
  }
  if (input.action === 'uninstall') {
    if (!input.packageFullName) throw new Error('packageFullName is required; get it with list.');
    args.push('-package', input.packageFullName);
  }
  args.push(input.ip ? '-ip' : '-guid', input.ip ?? input.guid);
  if (input.pin) args.push('-pin', input.pin);
  if (input.dependencies?.length) {
    if (input.action !== 'install') throw new Error('dependencies are supported by install only.');
    args.push('-dependency', ...input.dependencies.map(file => absolute(input, file)));
  }
  return { tool: 'winappdeploy', arguments: args };
}

const wpDeployment = z.object({ ...cliFields, platform: z.literal('wp81'),
  action: z.enum(['devices', 'install', 'installlaunch', 'update', 'updatelaunch', 'launch', 'uninstall']),
  target: z.string().regex(/^(xd|de|\d+)$/).optional(), package: text.optional(), productId: z.guid().optional() });
const mobileDeployment = z.object({ ...cliFields, platform: z.literal('win10m'),
  action: z.enum(['devices', 'install', 'update', 'list', 'uninstall']),
  ip: text.optional(), guid: z.guid().optional(), package: text.optional(), packageFullName: text.optional(),
  pin: text.optional(), dependencies: z.array(text).optional() });
const inputSchema = z.discriminatedUnion('action', [
  z.object({ ...processFields, action: z.literal('tap'), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), durationMs: z.number().int().min(1).max(10000).optional() }),
  z.object({ ...processFields, action: z.literal('swipe'), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), toX: z.number().int().nonnegative(), toY: z.number().int().nonnegative(), durationMs: z.number().int().min(1).max(10000).optional() }),
  z.object({ ...processFields, action: z.literal('key'), keys: z.array(text).min(1).max(64), mode: z.enum(['Type', 'Press', 'Release']).default('Type') }),
  z.object({ ...processFields, action: z.literal('text'), text: argument.min(1).max(8192) }),
  z.object({ ...processFields, action: z.literal('button'), button: text }),
]);

export const phoneDefinitions = [
  { name: 'phone_discover', readOnly: true, description: 'Find installed XDE versions, deployment CLIs and currently running WP8.1/Win10 Mobile emulators; returns validated process IDs and VM names.',
    schema: z.object(common), run: (input, ctx) => phone(input, 'discover', ctx) },
  { name: 'phone_devices', readOnly: true, description: 'Enumerate SDK/CoreCon device profiles and stable device GUIDs, preserving local display names and language.',
    schema: z.object({ ...common, localeId: deviceFields.localeId }), run: (input, ctx) => phone(input, 'devices', ctx) },
  { name: 'phone_start', description: 'Connect to a discovered emulator device GUID; the installed SDK starts its configured VM if needed. Refresh phone_discover after a timeout before retrying.',
    schema: z.object({ ...deviceFields, timeoutMs: common.timeoutMs.default(300000) }), run: (input, ctx) => phone(input, 'start', ctx) },
  { name: 'phone_status', readOnly: true, description: 'Read a running emulator state, readiness, guest resolution, zoom and supported device buttons by validated XDE processId.',
    schema: z.object(processFields), run: (input, ctx) => phone(input, 'status', ctx) },
  { name: 'phone_endpoint', readOnly: true, description: 'Read the selected emulator host and guest IP addresses for deployment or Device Portal connections.',
    schema: z.object(processFields), run: (input, ctx) => phone(input, 'endpoint', ctx) },
  { name: 'phone_screenshot', description: 'Capture the actual guest phone display to PNG and return an MCP image. A temporary file is created unless path is supplied; an existing explicit file is replaced only after a successful capture.',
    schema: z.object({ ...processFields, path: text.optional(), includeImage: z.boolean().default(true) }),
    run: async (input, ctx) => {
      const output = input.path ? path.resolve(input.path) : path.join(os.tmpdir(), 'vs2015-mcp-captures', `${randomUUID()}.png`);
      await mkdir(path.dirname(output), { recursive: true });
      return phone({ ...input, path: output }, 'capture', ctx);
    },
    formatResult: async (result, input) => {
      const size = (await stat(result.path)).size;
      const response = asToolResult(input.includeImage && size > 4194304
        ? { ...result, imageOmitted: 'PNG exceeds the 4 MiB inline image limit; use the returned local path.' } : result);
      if (input.includeImage && size <= 4194304) {
        response.content.push({ type: 'image', mimeType: 'image/png', data: (await readFile(result.path)).toString('base64') });
      }
      return response;
    } },
  { name: 'phone_input', description: 'Issue tap/swipe in guest pixels, text, virtual key names or supported skin buttons to one emulator. Type sends keys sequentially; use Press/Release for modifiers. Verify effects with phone_screenshot because XDE can swallow input failures.',
    schema: inputSchema, run: (input, ctx) => phone(input, input.action, ctx) },
  { name: 'phone_stop', description: 'Request Close on the selected XDE emulator only. Unsaved guest app state can be lost.',
    schema: z.object(processFields), run: (input, ctx) => phone(input, 'stop', ctx) },
  { name: 'phone_apps', description: 'List/launch/terminate/uninstall apps by CoreCon device GUID and ProductID. Connecting may start the emulator. For UWP identities not exposed by CoreCon, use Windows Mobile Device Portal.',
    schema: z.object({ ...deviceFields, action: z.enum(['list', 'launch', 'terminate', 'uninstall']), productId: z.guid().optional() }),
    run: (input, ctx) => {
      if (input.action !== 'list' && !input.productId) throw new Error('productId is required for application actions.');
      return phone(input, { list: 'applications', launch: 'appLaunch', terminate: 'appStop', uninstall: 'appUninstall' }[input.action], ctx);
    } },
  { name: 'phone_cli_help', readOnly: true, description: 'Read the selected installed phone deployment CLI help before using version-dependent options.',
    schema: z.object({ ...cliFields, tool: cliNames }), run: (input, ctx) => cli(input, input.tool, [input.tool === 'winappdeploy' ? '-help' : '/?'], ctx) },
  { name: 'phone_cli', description: 'Run AppDeployCmd, XapDeployCmd or WinAppDeployCmd with literal argv, timeout and bounded output. An explicit toolPath supports custom SDK installations. Pairing PIN arguments are redacted from results.',
    schema: z.object({ ...cliFields, tool: cliNames, arguments: z.array(argument).max(512) }), run: (input, ctx) => cli(input, input.tool, input.arguments, ctx) },
  { name: 'phone_deploy', description: 'Discover deployment targets or deploy/update/launch/uninstall WP8.1 packages; discover/list/deploy/update/uninstall Win10 Mobile packages. Requires installed SDKs and developer-unlocked or paired target. dryRun returns the command plan.',
    schema: z.discriminatedUnion('platform', [wpDeployment, mobileDeployment]),
    run: (input, ctx) => { const plan = planPhoneDeployment(input); return cli(input, plan.tool, plan.arguments, ctx); } },
];

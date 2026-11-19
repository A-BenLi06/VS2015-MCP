import * as z from 'zod/v4';
import { readFile, stat } from 'node:fs/promises';
import { PhoneSessionManager, PHONE_IDE_TOOL_ALLOWLIST } from './phone-session-manager.mjs';
import { ideDefinitions } from './ide.mjs';
import { invokeIde } from './ide-client.mjs';
import { asToolResult } from './tools.mjs';

const text = z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'NUL is not allowed');
const timeoutMs = z.number().int().min(1000).max(600000).default(15000);
const scope = z.enum(['project', 'activeConfiguration']).default('activeConfiguration');
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const binding = z.object({ sessionId: z.guid(), projectUniqueName: text, targetPropertyName: text, scope,
  manifestPath: text.optional(), applicationId: text.optional(),
  targetGuards: z.array(z.object({ name: text, scope, value: scalar }).strict()).max(32).optional(),
}).strict();
const session = { phoneSessionId: z.guid(), timeoutMs };
const inputSchema = z.discriminatedUnion('action', [
  z.object({ ...session, action: z.literal('tap'), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), durationMs: z.number().int().min(1).max(10000).optional() }).strict(),
  z.object({ ...session, action: z.literal('swipe'), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), toX: z.number().int().nonnegative(), toY: z.number().int().nonnegative(), durationMs: z.number().int().min(1).max(10000).optional() }).strict(),
  z.object({ ...session, action: z.literal('key'), keys: z.array(text).min(1).max(64), mode: z.enum(['Type', 'Press', 'Release']).default('Type') }).strict(),
  z.object({ ...session, action: z.literal('text'), text: z.string().min(1).max(8192).refine(value => !value.includes('\0'), 'NUL is not allowed') }).strict(),
  z.object({ ...session, action: z.literal('button'), button: text }).strict(),
]);
export function phoneSessionErrorResult(error) {
  const details = error.details ?? error.backendError?.details;
  return { error: { code: error.code ?? (error instanceof z.ZodError ? 'PHONE_IDE_ARGUMENTS_INVALID' : 'PHONE_SESSION_ERROR'), message: error.message,
    ...(error.operationMayContinue !== undefined ? { operationMayContinue: error.operationMayContinue } : {}),
    ...(error.cleanupStatus !== undefined ? { cleanupStatus: error.cleanupStatus } : {}),
    ...(error.cleanupWarnings ? { cleanupWarnings: error.cleanupWarnings } : {}),
    ...(error.cleanupDetails ? { cleanupDetails: error.cleanupDetails } : {}),
    ...(error.backendError ? { backendError: error.backendError } : {}),
    ...(details ? { details } : {}),
    ...(error.reason ? { reason: error.reason } : {}),
  } };
}
export async function formatPhoneSessionScreenshot(result, input) {
  if (result.error) return asToolResult(result);
  const size = (await stat(result.path)).size;
  const response = asToolResult(input.includeImage && size > 4194304 ? { ...result, imageOmitted: 'PNG exceeds the 4 MiB inline image limit; use the returned local path.' } : result);
  if (input.includeImage && size <= 4194304) response.content.push({ type: 'image', mimeType: 'image/png', data: (await readFile(result.path)).toString('base64') });
  return response;
}
export function createPhoneSessionDefinitions(manager) {
  const run = method => async (input, ctx = {}) => { try { return await manager[method](input, ctx); } catch (error) { return phoneSessionErrorResult(error); } };
  return [
    { name: 'phone_session_open', description: 'Open an opaque session pinned to explicit XDE PID/start/Hyper-V GUID with its own persistent SDK process. Optional IDE binding requires exact CoreCon GUID/locale and endpoint-pair proof plus an included saved project manifest. Initial verification is project-only until vs2015_ide_guest_app_identity confirms a paused debuggee.',
      schema: z.object({ processId: z.number().int().positive().max(2147483647), expectedStartTimeUtc: z.iso.datetime({ offset: true }), expectedVmId: z.guid(),
        xdeRoots: z.array(text).max(32).optional(), coreConDeviceId: z.guid().optional(), localeId: z.number().int().min(1).max(65535).optional(),
        coreConServicePort: z.number().int().min(0).max(65535).optional(), ideBinding: binding.optional(), timeoutMs: timeoutMs.default(30000),
      }).strict().superRefine((value, ctx) => {
        if (Boolean(value.coreConDeviceId) !== (value.localeId !== undefined)) ctx.addIssue({ code: 'custom', message: 'Supply coreConDeviceId and localeId together.' });
        if (value.ideBinding && !value.coreConDeviceId) ctx.addIssue({ code: 'custom', message: 'IDE binding requires coreConDeviceId and localeId.' });
      }), run: run('open') },
    { name: 'phone_session_status', readOnly: true, description: 'Validate the pinned SDK/VM and optional IDE/project/manifest/target binding, then read emulator readiness, display and held keys.', schema: z.object(session).strict(), run: run('status') },
    { name: 'phone_session_endpoint', readOnly: true, description: 'Validate this session and read its actual emulator endpoint addresses; no target is selected by display name.', schema: z.object(session).strict(), run: run('endpoint') },
    { name: 'phone_session_input', description: 'Validate the complete pinned session and send guest-pixel input through its cached SDK input client. Press/Release state survives calls. Inspect actual guest state after input; uncertain operations are never replayed.', schema: inputSchema, run: run('input') },
    { name: 'phone_session_screenshot', description: 'Validate this pinned session and atomically capture its actual guest PNG. Return an inline image up to 4 MiB; larger files remain available at the returned path.',
      schema: z.object({ ...session, path: text.optional(), includeImage: z.boolean().default(true) }).strict(), run: run('screenshot'), formatResult: formatPhoneSessionScreenshot },
    { name: 'phone_session_close', description: 'Release this session and its held keys using only its original SDK handle, then end that controller. IDE validation is bypassed for cleanup. The emulator VM is left running.', schema: z.object(session).strict(), run: run('close') },
    { name: 'phone_session_ide', description: 'Route an explicitly allowlisted IDE build/debug/document/XAML/guest-identity tool through this validated phone binding. Existing tool schemas apply and the IDE session is forced. Configuration, startup, target-property changes, opening solutions and detach are forbidden. Run vs2015_ide_guest_app_identity on a paused debuggee to confirm guest-matched identity against the bound manifest; other calls remain project-only.',
      schema: z.object({ ...session, timeoutMs: z.number().int().min(1000).max(600000).optional(), toolName: z.enum(PHONE_IDE_TOOL_ALLOWLIST), arguments: z.record(z.string(), z.unknown()).default({}) }).strict(), run: run('ide') },
  ];
}
// Construct one manager per MCP connection. Each open creates another dedicated
// PhoneBridgeClient, so WP8.1 and Win10 SDK assemblies never share a process.
export function createPhoneSessionTools(options = {}) {
  const manager = new PhoneSessionManager({ ideInvoke: invokeIde, ideDefinitions, ...options });
  return { manager, definitions: createPhoneSessionDefinitions(manager), stop: () => manager.stopAll() };
}

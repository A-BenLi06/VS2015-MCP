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
  const wpr = action => (input, ctx) => run('guestWpr')({ ...input, action }, ctx);
  const wprSession = { phoneSessionId: session.phoneSessionId, timeoutMs: timeoutMs.default(240000) };
  const portal = action => (input, ctx) => run('portal')({ ...input, action }, ctx);
  const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
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
    { name: 'phone_session_wpr_status', description: 'Read WP8.1 guest WPR native status on this bound CoreCon session. First use deploys and starts the installed developer agent. Preserve unknown status and raw native output. Creates or joins a history run containing command logs and capture receipts.',
      schema: z.object({ ...wprSession, runId: z.guid().optional() }).strict(), run: wpr('status') },
    { name: 'phone_session_wpr_start', description: 'Start a WP8.1 guest CPU sample capture after checking the exact observed status fingerprint. Requires exclusive guest profiling. Explicit allowUnknownStatus accepts the observed unknown native status. Existing recordings are refused. Store the captureId for stop. External profiler clients are outside the session lock.',
      schema: z.object({ ...wprSession, operation: text, profiles: z.array(z.literal('cpu')).length(1).default(['cpu']), exclusiveGuest: z.literal(true),
        observedStatusFingerprint: z.string().regex(/^[a-f0-9]{64}$/), allowUnknownStatus: z.boolean().default(false) }).strict(), run: wpr('start') },
    { name: 'phone_session_wpr_stop', description: 'Stop only this controller\'s owned capture after rechecking its profile set, download a unique guest ETL, hash it and save a history artifact. An uncertain stop is never replayed. Trace header checks leave event, symbol and application attribution unverified. Closing a session preserves active recording and reports its receipt.',
      schema: z.object({ ...wprSession, captureId: z.guid(), exclusiveGuest: z.literal(true) }).strict(), run: wpr('stop') },
    { name: 'phone_session_portal_connect', description: 'Connect an already enabled Windows Mobile Device Portal at the exact guest IP of this CoreCon-bound session. Supply an explicit HTTP(S) origin; HTTP needs allowInsecureHttp. Optional credentials come from named server environment variables and a PEM CA can be supplied. OS identity is pinned; redirects and automatic retries are refused. Does not enable or pair the portal.',
      schema: z.object({ ...session, baseUrl: text, allowInsecureHttp: z.boolean().default(false), usernameEnv: environmentName.optional(), passwordEnv: environmentName.optional(), caPath: text.optional(), runId: z.guid().optional() }).strict()
        .superRefine((value, ctx) => { if (Boolean(value.usernameEnv) !== Boolean(value.passwordEnv)) ctx.addIssue({ code: 'custom', message: 'Supply usernameEnv and passwordEnv together.' }); }), run: portal('connect') },
    { name: 'phone_session_portal_read', readOnly: true, description: 'Read OS, installed packages, guest processes, system performance, ETW providers, WPR profiles or trace files from the bound Device Portal. Preserve the target response and save a history artifact. Process fields are observations, not app attribution or managed heap data.',
      schema: z.object({ ...session, resource: z.enum(['os', 'packages', 'processes', 'systemPerformance', 'etwProviders', 'profiles', 'traceFiles']) }).strict(), run: portal('read') },
    { name: 'phone_session_portal_wpr_status', readOnly: true, description: 'Read Device Portal WPR status and the actual profile catalog with fingerprints. Never issues GET /api/wpr/trace, which stops tracing. Choose a profile name string in the catalog using its JSON Pointer.',
      schema: z.object(session).strict(), run: portal('status') },
    { name: 'phone_session_portal_wpr_start', description: 'Start a guest WPR trace only from observed Idle/normal status and an unchanged device profile catalog. Select the actual profile string with profilePointer (JSON Pointer). Requires exclusive guest profiling: WDP has no remote ownership token and external tools are outside the local lock. Returns captureId and a durable receipt; uncertain start is never replayed.',
      schema: z.object({ ...wprSession, operation: text, profilePointer: text, observedStatusFingerprint: z.string().regex(/^[a-f0-9]{64}$/), profilesFingerprint: z.string().regex(/^[a-f0-9]{64}$/), exclusiveGuest: z.literal(true) }).strict(), run: portal('start') },
    { name: 'phone_session_portal_wpr_stop', description: 'Stop this Portal connection\'s owned capture once. Confirms Idle, retains direct ETL or lists new trace files for the separate download tool. An uncertain stop is never replayed. VM/endpoint identity is still checked if the IDE has closed. Header validation does not prove trace event content.',
      schema: z.object({ ...wprSession, captureId: z.guid(), exclusiveGuest: z.literal(true) }).strict(), run: portal('stop') },
    { name: 'phone_session_portal_wpr_download', description: 'Download a new ETL associated with a confirmed stopped capture, preserving bytes/SHA256 and history. Select filename from candidateFiles if ambiguous. A failed download can be explicitly retried without issuing another Stop. No guest trace files are deleted.',
      schema: z.object({ ...wprSession, captureId: z.guid(), filename: text.optional() }).strict(), run: portal('download') },
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

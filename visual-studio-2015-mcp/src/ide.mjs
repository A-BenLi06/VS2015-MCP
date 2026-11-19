import * as z from 'zod/v4';
import { invokeIde } from './ide-client.mjs';

const text = z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'Must not contain NUL');
const sessionId = z.guid();
const deadlineBounds = z.number().int().min(1000).max(600000);
const deadline = deadlineBounds.default(15000);
const session = { sessionId, timeoutMs: deadline };
const limit = z.number().int().min(1).max(200).default(50);
const phoneTargetGuard = z.object({ name: text, scope: z.enum(['project', 'activeConfiguration']), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict();
const expectedPhoneBinding = z.object({ configurationToken: text, projectUniqueName: text, targetPropertyName: text,
  scope: z.enum(['project', 'activeConfiguration']), deviceId: z.guid(), manifestPath: text,
  manifestSha256: z.string().regex(/^[a-fA-F0-9]{64}$/), applicationId: text, targetGuards: z.array(phoneTargetGuard).max(32).optional() }).strict();
const call = operation => async (input, ctx) => {
  try { return await invokeIde(operation, input, ctx); }
  catch (error) { return { error: { code: error.code ?? 'IDE_OPERATION_FAILED', message: error.message,
    ...(error.operationMayContinue !== undefined ? { operationMayContinue: error.operationMayContinue } : {}),
    ...(error.backendError?.details ? { details: error.backendError.details } : {}) } }; }
};

export const ideDefinitions = [
  { name: 'vs2015_instances', readOnly: true, description: 'Enumerate running VS2015 IDE instances from the Running Object Table, with exact PID and start-time identity. Does not start or select an IDE.',
    schema: z.object({ timeoutMs: deadline }), run: call('instances') },
  { name: 'vs2015_attach', description: 'Connect this persistent STA bridge to the explicitly selected running VS2015 PID and expected start time. Returns an opaque sessionId; later calls always name that session. Does not attach the debugger to an application.',
    schema: z.object({ processId: z.number().int().positive().max(2147483647), expectedStartTimeUtc: z.iso.datetime({ offset: true }), timeoutMs: deadline }), run: call('attach') },
  { name: 'vs2015_detach', description: 'Release an IDE automation session and event subscriptions. Leaves the Visual Studio process and its debugger/build state running.',
    schema: z.object(session), run: call('detach') },
  { name: 'vs2015_solution_status', readOnly: true, description: 'Read the actual solution loaded in the selected IDE, active configuration/platform, startup projects, project state and debugger mode. Includes unsaved IDE state rather than only parsing the disk solution.',
    schema: z.object(session), run: call('solutionStatus') },
  { name: 'vs2015_solution_configurations', readOnly: true, description: 'Enumerate actual solution configuration/platform pairs, per-project build/deploy mappings, startup projects and recursively discovered projects. Return a configurationToken for guarded mutations.',
    schema: z.object(session), run: call('configurations') },
  { name: 'vs2015_solution_configure', description: 'Activate an existing configuration/platform pair and optionally set explicit project uniqueNames as startup projects. Requires a current configurationToken and design/idle state. Does not invent debugger target properties.',
    schema: z.object({ ...session, configuration: text, platform: text, startupProjects: z.array(text).min(1).max(32).optional(), expectedConfigurationToken: text }), run: call('configureSolution') },
  { name: 'vs2015_project_build', description: 'Build or deploy an explicitly discovered project and its configured dependencies using the IDE active solution configuration. Requires the current configurationToken; wait for the project-scope completion events via build_status.',
    schema: z.object({ ...session, projectUniqueName: text, action: z.enum(['build', 'deploy']).default('build'), expectedConfigurationToken: text }), run: call('projectBuild') },
  { name: 'vs2015_project_properties', readOnly: true, description: 'Enumerate actual project or active-configuration property names/indices without invoking Value getters. Pass an explicit propertyName to read that value; some legacy project getters are unsafe inside VS2015. Target-specific settings are discovered, not assumed.',
    schema: z.object({ ...session, projectUniqueName: text, scope: z.enum(['project', 'activeConfiguration']).default('activeConfiguration'), propertyName: text.optional(), limit: z.number().int().min(1).max(500).default(100) }), run: call('projectProperties') },
  { name: 'vs2015_project_app_identity', readOnly: true, description: 'Read schema-qualified package, phone ProductID and application identities from an actual included Appx manifest of the selected IDE project. Reject unsaved manifests, ambiguous candidates and unsafe XML; return the exact saved-byte SHA-256 and configuration identity.',
    schema: z.object({ ...session, projectUniqueName: text, manifestPath: text.optional() }), run: call('projectAppIdentity') },
  { name: 'vs2015_project_property_set', description: 'Set one explicitly discovered project property in design/idle mode with exact expectedValue and configurationToken guards; read back to confirm. Property support and writeability depend on the selected project system.',
    schema: z.object({ ...session, projectUniqueName: text, scope: z.enum(['project', 'activeConfiguration']).default('activeConfiguration'), propertyName: text,
      expectedValue: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]), expectedConfigurationToken: text }), run: call('setProjectProperty') },
  { name: 'vs2015_open_solution', description: 'Open an existing solution in the selected design-mode IDE when it has no solution open. Existing solutions and user dialogs are not dismissed automatically.',
    schema: z.object({ ...session, path: text }), run: call('openSolution') },
  { name: 'vs2015_build_active', description: 'Start build/rebuild/clean/deploy using the selected IDE active solution configuration. Returns a buildId immediately; completion must be observed with build_status/events. Rejects overlapping owned builds.',
    schema: z.object({ ...session, action: z.enum(['build', 'rebuild', 'clean', 'deploy']).default('build') }), run: call('buildActive') },
  { name: 'vs2015_build_status', readOnly: true, description: 'Read the selected IDE build operation by buildId. Complete is based on OnBuildDone events, not the return of SolutionBuild.Build. LastBuildInfo is the count of failed projects, not the diagnostic error count.',
    schema: z.object({ ...session, buildId: z.guid() }), run: call('buildStatus') },
  { name: 'vs2015_build_reconcile', description: 'Explicitly reconcile a stale IDE build record after querying actual BuildState. If the IDE is idle but completion evidence is missing, mark the record unconfirmed and release the automation build lock. Never infer build success or cancel an active IDE build.',
    schema: z.object({ ...session, buildId: z.guid() }), run: call('buildReconcile') },
  { name: 'vs2015_ide_events', readOnly: true, description: 'Read bounded build/debugger events from the persistent IDE session by sequence cursor. Use actual debugger transitions to observe breakpoint hits and build completion.',
    schema: z.object({ ...session, afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100) }), run: call('events') },
  { name: 'vs2015_documents', readOnly: true, description: 'Enumerate open IDE documents with paths, active document and saved/unsaved state.',
    schema: z.object(session), run: call('documents') },
  { name: 'vs2015_document_open', description: 'Open a file in the selected IDE text/code view and optionally navigate to its 1-based line/column. Explicit replaceSavedView closes an existing saved editor before switching factories; unsaved views are rejected and dialogs are never auto-answered.',
    schema: z.object({ ...session, path: text, view: z.enum(['text', 'code']).default('text'), replaceSavedView: z.boolean().default(false), line: z.number().int().positive().optional(), column: z.number().int().positive().optional() }), run: call('openDocument') },
  { name: 'vs2015_document_read', readOnly: true, description: 'Read text from an already open IDE document, including unsaved edits. Bounded output explicitly indicates truncation; use the exact whole text as expectedText when replacing.',
    schema: z.object({ ...session, path: text, maxChars: z.number().int().min(1).max(1000000).default(64000) }), run: call('readDocument') },
  { name: 'vs2015_document_replace', description: 'Replace the whole text of an already open IDE document only when its current text exactly equals expectedText. Changes remain unsaved unless save=true; conflicts are rejected.',
    schema: z.object({ ...session, path: text, expectedText: z.string().max(1000000), text: z.string().max(1000000), save: z.boolean().default(false) }), run: call('editDocument') },
  { name: 'vs2015_document_save', description: 'Save the explicitly selected open IDE document to its existing path.',
    schema: z.object({ ...session, path: text }), run: call('saveDocument') },
  { name: 'vs2015_document_edit', description: 'Apply non-overlapping source ranges as one IDE undo transaction, guarded by the current full-buffer SHA-256. Positions are 1-based UTF-16 line/column with exclusive end; preserve editor markers, reject conflicts before editing, and keep changes unsaved unless save=true.',
    schema: z.object({ ...session, path: text, expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i), save: z.boolean().default(false),
      edits: z.array(z.object({ start: z.object({ line: z.number().int().positive(), column: z.number().int().positive() }),
        end: z.object({ line: z.number().int().positive(), column: z.number().int().positive() }), expectedText: z.string().max(1000000).optional(), text: z.string().max(1000000) })).min(1).max(100) }), run: call('editDocumentRanges') },
  { name: 'vs2015_ide_errors_output', readOnly: true, description: 'Read the IDE Error List or a bounded Output Window pane. Error messages and pane names retain their installed language; use returned pane GUIDs for exact output selection.',
    schema: z.object({ ...session, kind: z.enum(['errors', 'output']).default('errors'), offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100), paneGuid: text.optional(), maxChars: z.number().int().min(1).max(1000000).default(64000) }), run: call('errorsOutput') },
  { name: 'vs2015_ide_debug_state', readOnly: true, description: 'Read design/run/break mode, debugged processes and the last debugger transition from the selected IDE session.',
    schema: z.object(session), run: call('debugState') },
  { name: 'vs2015_ide_debug_breakpoints', description: 'Observe IDE breakpoints or add session-owned breakpoints by file/line or function. Only owned=true breakpoints can be deleted; listing never grants ownership. Graceful detach removes owned breakpoints and preserves observed developer breakpoints.',
    schema: z.object({ ...session, action: z.enum(['list', 'add', 'delete']).default('list'), file: text.optional(), line: z.number().int().positive().optional(),
      function: text.optional(), breakpointId: z.guid().optional() }).superRefine((value, ctx) => {
        if (value.action === 'add' && !(Boolean(value.file && value.line) !== Boolean(value.function))) ctx.addIssue({ code: 'custom', message: 'Add requires either file+line or function.' });
        if (value.action === 'delete' && !value.breakpointId) ctx.addIssue({ code: 'custom', message: 'Delete requires breakpointId.' });
      }), run: call('breakpoints') },
  { name: 'vs2015_ide_debug_control', description: 'Issue asynchronous IDE debugger commands and inspect events/wait for actual transitions. Optional expectedPhoneBinding rechecks the configuration, sole startup project, device property and saved manifest inside the same STA dispatch before executing; stop bypasses this guard for recovery. go defaults to a separate 120-second command budget for phone launch.',
    schema: z.object({ ...session, timeoutMs: deadlineBounds.optional(), action: z.enum(['go', 'break', 'stepInto', 'stepOver', 'stepOut', 'stop']), expectedPhoneBinding: expectedPhoneBinding.optional() }),
    run: (input, ctx) => call('debugControl')({ ...input, timeoutMs: input.timeoutMs ?? (input.action === 'go' ? 120000 : 15000) }, ctx) },
  { name: 'vs2015_ide_debug_inspect', readOnly: true, description: 'Inspect debugger threads, current-thread stack frames, or locals of the current frame in break mode. Does not switch the developer selected thread/frame.',
    schema: z.object({ ...session, kind: z.enum(['threads', 'frames', 'locals']), limit, pauseId: z.guid().optional(), frameId: z.guid().optional() }), run: call('debugInspect') },
  { name: 'vs2015_ide_debug_select_thread', description: 'Select a thread observed in the current paused debugged program. Requires its opaque threadId and current pauseId; resumed or stale contexts are rejected.',
    schema: z.object({ ...session, pauseId: z.guid(), threadId: z.guid() }), run: call('selectThread') },
  { name: 'vs2015_ide_debug_select_frame', description: 'Select a stack frame observed for the currently selected thread during this pause. Source path, line and depth come from the actual debugger StackFrame2 when available.',
    schema: z.object({ ...session, pauseId: z.guid(), frameId: z.guid() }), run: call('selectFrame') },
  { name: 'vs2015_ide_debug_evaluate', description: 'Explicitly evaluate a debugger expression in the current break-mode frame. Evaluation may execute properties or application code; pass only an expression intended to run in the debuggee.',
    schema: z.object({ ...session, expression: z.string().min(1).max(16384).refine(value => !value.includes('\0')), evaluationTimeoutMs: z.number().int().min(100).max(10000).default(1000), pauseId: z.guid().optional(), frameId: z.guid().optional() }),
    run: async (input, ctx) => call('evaluate')({ ...input, expressionTimeoutMs: input.evaluationTimeoutMs }, ctx) },
  { name: 'vs2015_ide_guest_app_identity', description: 'Explicitly evaluate fixed Windows Runtime SDK identity properties in the current paused debuggee. Requires current pause/frame tokens, preserves raw ProductId validity separately, and returns unconfirmed if execution context changes. SDK getters may execute application code. Does not infer that the observed guest matches a project.',
    schema: z.object({ ...session, pauseId: z.guid(), frameId: z.guid(), includeProductId: z.boolean().default(true), evaluationTimeoutMs: z.number().int().min(100).max(10000).default(3000) }),
    run: async (input, ctx) => call('guestDebugAppIdentity')({ ...input, expressionTimeoutMs: input.evaluationTimeoutMs }, ctx) },
  { name: 'vs2015_ide_xaml_tree', description: 'Inspect a bounded WinRT XAML visual tree (Window.Current.Content or an observed rootNodeId subtree) in the current paused UI thread via standard SDK evaluation. Returns snapshot-scoped opaque nodeIds; read-only queries retire previous snapshot IDs.',
    schema: z.object({ sessionId, timeoutMs: deadlineBounds.optional(), pauseId: z.guid(), frameId: z.guid().optional(), rootNodeId: z.guid().optional(),
      queryTimeoutMs: z.number().int().min(1000).max(120000).default(15000), maxDepth: z.number().int().min(0).max(16).default(8),
      maxNodes: z.number().int().min(1).max(500).default(100), maxChildren: z.number().int().min(1).max(128).default(64),
      evaluationTimeoutMs: z.number().int().min(100).max(5000).default(1000) }),
    run: async (input, ctx) => call('xamlTree')({ ...input, expressionTimeoutMs: input.evaluationTimeoutMs, timeoutMs: input.timeoutMs ?? Math.max(25000, (input.queryTimeoutMs ?? 15000) + 10000) }, ctx) },
  { name: 'vs2015_ide_xaml_action', description: 'Execute a guarded WinRT XAML automation action (invoke via IInvokeProvider, setValue via IValueProvider, or explicit setText on an enabled non-read-only TextBox) on an observed nodeId in break mode. Retires snapshot IDs; never automatically retries uncertain dispatches.',
    schema: z.object({ ...session, pauseId: z.guid(), frameId: z.guid().optional(), nodeId: z.guid(), action: z.enum(['invoke', 'setValue', 'setText']),
      value: z.string().max(4096).refine(value => !value.includes('\0'), 'Must not contain NUL').optional(),
      evaluationTimeoutMs: z.number().int().min(100).max(5000).default(1000) }).superRefine((value, ctx) => {
        if (value.action === 'invoke' && value.value !== undefined) ctx.addIssue({ code: 'custom', message: 'invoke does not accept value.' });
        if (value.action !== 'invoke' && value.value === undefined) ctx.addIssue({ code: 'custom', message: 'setValue and setText require value.' });
      }),
    run: async (input, ctx) => call('xamlAction')({ ...input, expressionTimeoutMs: input.evaluationTimeoutMs }, ctx) },
  { name: 'vs2015_ide_debug_wait', readOnly: true, description: 'Wait for the selected IDE debugger to reach design/run/break mode without blocking its STA message loop. Supply afterSequence from before go/step to require a newer debugger event, preventing an old break state from satisfying the wait. Cancellation only stops waiting; inspect events/reason/stack to identify a breakpoint.',
    schema: z.object({ ...session, mode: z.enum(['design', 'run', 'break']), afterSequence: z.number().int().nonnegative().optional(), pollIntervalMs: z.number().int().min(100).max(2000).default(250) }),
    run: async (input, ctx) => {
      const deadlineAt = Date.now() + input.timeoutMs;
      for (;;) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return { reached: false, timedOut: true, expectedMode: input.mode };
        const result = await call('debugState')({ sessionId: input.sessionId, timeoutMs: Math.min(remaining, 30000) }, ctx);
        // A transition during a read invalidates that snapshot. Poll a fresh
        // read; never replay the go/step command which started this wait.
        if (result.error && result.error.code !== 'DEBUG_CONTEXT_CHANGED') return result;
        if (!result.error && result.mode === input.mode && (input.afterSequence === undefined || result.lastDebuggerEventSequence > input.afterSequence)) return { reached: true, ...result };
        const wait = Math.min(input.pollIntervalMs, deadlineAt - Date.now());
        if (wait <= 0) return { reached: false, timedOut: true, expectedMode: input.mode, lastState: result };
        await new Promise((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(ctx?.signal?.reason ?? new Error('Wait cancelled.')); };
          const timer = setTimeout(() => { ctx?.signal?.removeEventListener('abort', aborted); resolve(); }, wait);
          ctx?.signal?.addEventListener('abort', aborted, { once: true });
          if (ctx?.signal?.aborted) aborted();
        });
      }
    } },
];

import * as z from 'zod/v4';
import { invokeIde } from './ide-client.mjs';

const text = z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'Must not contain NUL');
const sessionId = z.guid();
const deadline = z.number().int().min(1000).max(600000).default(15000);
const session = { sessionId, timeoutMs: deadline };
const limit = z.number().int().min(1).max(200).default(50);
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
  { name: 'vs2015_document_open', description: 'Open a file in the selected IDE and optionally navigate to its 1-based line/column.',
    schema: z.object({ ...session, path: text, line: z.number().int().positive().optional(), column: z.number().int().positive().optional() }), run: call('openDocument') },
  { name: 'vs2015_document_read', readOnly: true, description: 'Read text from an already open IDE document, including unsaved edits. Bounded output explicitly indicates truncation; use the exact whole text as expectedText when replacing.',
    schema: z.object({ ...session, path: text, maxChars: z.number().int().min(1).max(1000000).default(64000) }), run: call('readDocument') },
  { name: 'vs2015_document_replace', description: 'Replace the whole text of an already open IDE document only when its current text exactly equals expectedText. Changes remain unsaved unless save=true; conflicts are rejected.',
    schema: z.object({ ...session, path: text, expectedText: z.string().max(1000000), text: z.string().max(1000000), save: z.boolean().default(false) }), run: call('editDocument') },
  { name: 'vs2015_document_save', description: 'Save the explicitly selected open IDE document to its existing path.',
    schema: z.object({ ...session, path: text }), run: call('saveDocument') },
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
  { name: 'vs2015_ide_debug_control', description: 'Issue go/break/stepInto/stepOver/stepOut/stop through the IDE debugger. Commands are asynchronous; inspect state/events or debug_wait for actual transitions. go uses the current startup project and selected deployment/debug target, including configured phone targets.',
    schema: z.object({ ...session, action: z.enum(['go', 'break', 'stepInto', 'stepOver', 'stepOut', 'stop']) }), run: call('debugControl') },
  { name: 'vs2015_ide_debug_inspect', readOnly: true, description: 'Inspect debugger threads, current-thread stack frames, or locals of the current frame in break mode. Does not switch the developer selected thread/frame.',
    schema: z.object({ ...session, kind: z.enum(['threads', 'frames', 'locals']), limit }), run: call('debugInspect') },
  { name: 'vs2015_ide_debug_evaluate', description: 'Explicitly evaluate a debugger expression in the current break-mode frame. Evaluation may execute properties or application code; pass only an expression intended to run in the debuggee.',
    schema: z.object({ ...session, expression: z.string().min(1).max(16384).refine(value => !value.includes('\0')), evaluationTimeoutMs: z.number().int().min(100).max(10000).default(1000) }),
    run: async (input, ctx) => call('evaluate')({ ...input, expressionTimeoutMs: input.evaluationTimeoutMs }, ctx) },
  { name: 'vs2015_ide_debug_wait', readOnly: true, description: 'Wait for the selected IDE debugger to reach design/run/break mode without blocking its STA message loop. Supply afterSequence from before go/step to require a newer debugger event, preventing an old break state from satisfying the wait. Cancellation only stops waiting; inspect events/reason/stack to identify a breakpoint.',
    schema: z.object({ ...session, mode: z.enum(['design', 'run', 'break']), afterSequence: z.number().int().nonnegative().optional(), pollIntervalMs: z.number().int().min(100).max(2000).default(250) }),
    run: async (input, ctx) => {
      const deadlineAt = Date.now() + input.timeoutMs;
      for (;;) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return { reached: false, timedOut: true, expectedMode: input.mode };
        const result = await call('debugState')({ sessionId: input.sessionId, timeoutMs: Math.min(remaining, 30000) }, ctx);
        if (result.error) return result;
        if (result.mode === input.mode && (input.afterSequence === undefined || result.lastDebuggerEventSequence > input.afterSequence)) return { reached: true, ...result };
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

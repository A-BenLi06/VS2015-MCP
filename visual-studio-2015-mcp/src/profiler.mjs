import * as z from 'zod/v4';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { invokeBackend } from './bridge.mjs';
import { createRun, readRun, runDirectory, saveArtifact, appendEvent } from './history.mjs';

const text = z.string().min(1).refine(value => !value.includes('\0'), 'Must not contain NUL');
const roots = { vsRoot: text.optional(), performanceRoot: text.optional(), perfViewPath: text.optional(), toolPath: text.optional() };
const common = { ...roots, architecture: z.enum(['x86', 'x64']).default('x86'), workingDirectory: text.optional(),
  timeoutMs: z.number().int().min(100).max(3600000).default(120000), maxOutputChars: z.number().int().min(256).max(1048576).default(64000),
  encoding: text.optional(), dryRun: z.boolean().default(true), runId: z.guid().optional() };

async function execute(operation, input, ctx) {
  const capture = operation === 'capture';
  const request = { ...input, operation, vsRoot: input.vsRoot ?? process.env.VS2015_MCP_ROOT };
  const bridge = { ...ctx, script: operation === 'extract' ? 'Extract-ProfileTrace.ps1' : 'Invoke-Profiler.ps1', preserveBackendErrors: true };
  if (operation === 'discover' || input.dryRun) return invokeBackend(request, bridge);
  const history = input.runId ? await readRun(input.runId) : await createRun({ operation: `profiler:${operation}` });
  if (['report', 'offlineReport', 'capture', 'extract'].includes(operation)) request.outputDirectory = runDirectory(history.id);
  if (capture) {
    request.stopFile = path.join(runDirectory(history.id), `stop-${randomUUID()}`);
    request.timeoutMs = input.durationMs + input.startupTimeoutMs + input.cleanupTimeoutMs + 30000;
    request.setupTimeoutMs = 0;
    bridge.cooperativeStopFile = request.stopFile;
    bridge.cleanupGraceMs = 60000;
  }
  await appendEvent(history.id, { kind: 'profilerStarted', operation, processId: input.processId });
  let result;
  try { result = await invokeBackend(request, bridge); }
  catch (error) { result = { ...(error.backendResult ?? {}), error: { code: 'PROFILER_INTERRUPTED', message: error.message } }; }
  const artifact = await saveArtifact(history.id, capture ? 'profiler-capture' : 'profiler-report', { operation, result });
  // Nested native results must retain MCP failure semantics.
  if (result.execution) Object.assign(result, { exitCode: result.execution.exitCode, timedOut: result.execution.timedOut });
  if (capture && result.status && result.status !== 'completed' && !result.error) {
    result.error = { code: 'PROFILE_INCOMPLETE', message: `Capture status: ${result.status}; inspect cleanup state and trace quality before analysis.` };
  }
  const { path: artifactPath, ...reference } = artifact;
  return { ...result, ...(capture ? { captureId: result.runId ?? result.capture?.runId } : {}), ...reference, artifactPath };
}
export const profilerDefinitions = [
  { name: 'vs2015_profiler_discover', readOnly: true, description: 'Find installed VS2015 Performance Tools and optional PerfView, report versions and elevation. Discovery does not start a profiler.',
    schema: z.object(roots), run: (input, ctx) => execute('discover', input, ctx) },
  { name: 'vs2015_profiler_cli', description: 'Use installed profiler help/status, offline VSPerfReport commands (including Diff/QueryDiffTables), or read-only VSInstr DumpFuncs. Raw instrumentation, global start/stop and report mutation switches are rejected. Defaults to dry-run.',
    schema: z.object({ ...common, tool: z.enum(['vsperf', 'vsperfcmd', 'vsperfreport', 'vsinstr', 'perfview']),
      arguments: z.array(z.string().refine(value => !value.includes('\0'))).max(512) }), run: (input, ctx) => execute('runKnown', input, ctx) },
  { name: 'vs2015_profiler_report', description: 'Export existing VSPerfReport .vsp/.vsps input to CSV/XML in a new history directory, with optional PID and millisecond window filters. VSPX, ETL and diagsession are distinct formats. Defaults to dry-run.',
    schema: z.object({ ...common, inputPath: text,
      summaryTypes: z.array(z.enum(['All', 'CallerCallee', 'CallTree', 'Counter', 'Function', 'Ip', 'Life', 'Line', 'Header', 'Mark', 'Module', 'Process', 'Thread', 'Type', 'Contention', 'RuleWarnings'])).min(1).default(['Header', 'Process', 'Function']),
      format: z.enum(['csv', 'xml']).default('csv'), processId: z.number().int().positive().optional(), startMs: z.number().int().nonnegative().optional(),
      durationMs: z.number().int().positive().optional(), symbolPath: text.optional() }), run: (input, ctx) => execute('report', input, ctx) },
  { name: 'vs2015_profiler_capture', description: 'Bounded VSPerf.exe CPU capture of an existing HOST PID on Windows 10. Requires an already elevated server and exclusive VS profiler use. Refuses existing sessions; only detaches after ownership checks. Defaults to dry-run; administrator collection is not yet validated on this host. Preserves recovery state on failure. Does not kill target.',
    schema: z.object({ ...common, backend: z.literal('vsperf').default('vsperf'), mode: z.literal('cpu').default('cpu'),
      processId: z.number().int().positive().max(2147483647), expectedStartTimeUtc: text.optional(), durationMs: z.number().int().min(1000).max(600000).default(10000),
      startupTimeoutMs: z.number().int().min(1000).max(30000).default(10000), cleanupTimeoutMs: z.number().int().min(1000).max(15000).default(10000) }),
    run: (input, ctx) => execute('capture', input, ctx) },
  { name: 'vs2015_perfview_report', description: 'Run a fixed OFFLINE PerfView CPU-stack/CSV or GCStats export on a copied ETL in a new directory. Requires a supplied PerfView executable. CPU selects the last process instance by NAME, not PID; GCStats reports all CLR processes. No live ETW collection. Defaults to dry-run.',
    schema: z.object({ ...common, analysis: z.enum(['cpuStacks', 'cpuCsv', 'gcStats']), inputPath: text, processName: text.optional() }),
    run: (input, ctx) => execute('offlineReport', input, ctx) },
  { name: 'vs2015_trace_extract', description: 'Inspect a VSPX or ETL.zip archive and extract one actual ETL member into a unique directory for offline analysis. Multiple ETL members require explicit selection. This validates container integrity, not trace events/symbol quality. Defaults to dry-run.',
    schema: z.object({ inputPath: text, entryName: text.optional(), maxBytes: z.number().int().min(1).max(4294967296).default(1073741824),
      dryRun: z.boolean().default(true), runId: z.guid().optional() }), run: (input, ctx) => execute('extract', input, ctx) },
];

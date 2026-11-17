import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRun, readRun, listRuns, timeline, appendEvent, saveArtifact, readArtifact, snapshotFile, runDirectory, csvRows, importHotspots, compareHotspots } from './history.mjs';
import { readJsonLines, summarizeSamples } from './samples.mjs';
import { invokeBackend } from './bridge.mjs';
import { asToolResult } from './tools.mjs';
import { compareProcessSummaries } from './process-comparison.mjs';

const id = z.guid();
const text = z.string().min(1).max(4096);
const context = z.record(z.string(), z.string());
const csv = { path: text, delimiter: z.string().length(1).default(','), encoding: text.default('utf-8'), headerRow: z.number().int().min(0).default(0) };
const artifactRef = { runId: id, artifactId: id };
const sampleRef = z.object({ ...artifactRef, actionId: id.optional() });

async function sampleSide(input) {
  const artifact = await readArtifact(input.runId, input.artifactId);
  if (artifact.kind !== 'process-samples') throw new Error('Expected a process-samples artifact.');
  let window = {}, action;
  if (input.actionId) {
    const { events } = await timeline(input.runId);
    const start = events.find(event => event.kind === 'actionStarted' && event.actionId === input.actionId);
    const end = events.find(event => event.kind === 'actionFinished' && event.actionId === input.actionId);
    if (!start || !end) throw new Error('Action span is incomplete or not part of this run.');
    window = { startUtc: start.timestampUtc, endUtc: end.timestampUtc };
    action = { ...window, label: start.label, toolName: start.toolName, success: end.success };
  }
  const trace = await readJsonLines(artifact.data.capture.path, { expectedSha256: artifact.data.source?.sha256 });
  const warnings = [...trace.warnings, ...(artifact.data.interrupted ? [artifact.data.interrupted] : [])];
  return { run: await readRun(input.runId), collector: artifact.data.collector, settings: artifact.data.settings,
    evidenceVerified: Boolean(artifact.data.source?.sha256), action,
    summary: { ...summarizeSamples(trace.events, { ...window, top: input.top, parseWarnings: warnings }), parseWarnings: warnings } };
}

export const observabilityDefinitions = [
  { name: 'vs2015_history_create', description: 'Create an immutable experiment/run identity with an operation label and comparable context (target, configuration, architecture, workload). Store revision separately so before/after builds can be compared.',
    schema: z.object({ operation: text, context: context.default({}), revision: text.optional() }), run: input => createRun(input) },
  { name: 'vs2015_history_list', readOnly: true, description: 'List recent locally recorded runs, optionally filtered by exact operation label.',
    schema: z.object({ operation: text.optional(), limit: z.number().int().min(1).max(200).default(30) }), run: async input => ({ runs: await listRuns(input) }) },
  { name: 'vs2015_history_read', readOnly: true, description: 'Read a run and its action/measurement timeline. Artifacts are separate immutable JSON files.',
    schema: z.object({ runId: id }), run: input => timeline(input.runId) },
  { name: 'vs2015_history_artifact', readOnly: true, description: 'Read a recorded artifact, including bounded debugger transcripts, profiler command results and measurement metadata, by run/artifact IDs.',
    schema: z.object(artifactRef), run: input => readArtifact(input.runId, input.artifactId) },
  { name: 'vs2015_profile_sample', description: 'Read CPU time, private/working-set memory and optional .NET Framework GC counters for one existing local PID. Does not suspend the target. Record a complete or explicitly partial JSONL trace in the run. These are process trends, not function hotspots.',
    schema: z.object({ runId: id, processId: z.number().int().positive(), durationMs: z.number().int().min(1000).max(300000).default(10000),
      intervalMs: z.number().int().min(250).max(30000).default(1000), includeClr: z.boolean().default(true) }),
    run: async (input, ctx) => {
      await readRun(input.runId);
      const measurement = { collector: 'vs2015-process-counters/1', settings: { intervalMs: input.intervalMs, includeClr: input.includeClr } };
      const outputPath = path.join(runDirectory(input.runId), `process-${randomUUID()}.jsonl`);
      await appendEvent(input.runId, { kind: 'captureStarted', processId: input.processId, outputPath });
      try {
        const result = await invokeBackend({ ...input, outputPath, timeoutMs: input.durationMs + 30000, setupTimeoutMs: 0 }, { ...ctx, script: 'Sample-Process.ps1' });
        const source = await snapshotFile(input.runId, outputPath);
        const trace = await readJsonLines(source.path, { expectedSha256: source.sha256 }), summary = summarizeSamples(trace.events, { parseWarnings: trace.warnings });
        const artifact = await saveArtifact(input.runId, 'process-samples', { ...measurement, capture: { ...result, path: source.path }, source, summary, parseWarnings: trace.warnings });
        return { ...artifact, summary };
      } catch (error) {
        let partial = null, snapshotError;
        try {
          const source = await snapshotFile(input.runId, outputPath);
          const trace = await readJsonLines(source.path, { expectedSha256: source.sha256 });
          const summary = summarizeSamples(trace.events, { parseWarnings: [...trace.warnings, error.message] });
          partial = await saveArtifact(input.runId, 'process-samples', { ...measurement, capture: { path: source.path, complete: false }, source, summary, interrupted: error.message });
        } catch (failure) { snapshotError = failure.message; }
        await appendEvent(input.runId, { kind: 'captureInterrupted', outputPath, message: error.message, partial, snapshotError });
        return { ...(partial ?? {}), error: { code: 'CAPTURE_INTERRUPTED', message: error.message }, snapshotError };
      }
    } },
  { name: 'vs2015_profile_summary', readOnly: true, description: 'Read a process capture, optionally selecting only full sample intervals within a recorded action span. Timing association does not establish causality.',
    schema: z.object({ ...artifactRef, actionId: id.optional(), top: z.number().int().min(1).max(100).default(10) }),
    run: async input => (await sampleSide(input)).summary },
  { name: 'vs2015_profile_compare', readOnly: true, description: 'Compare verified process captures or matching recorded action spans. Check operation/context/settings/collector and completeness. CPU and CLR rates use their own measured elapsed time; observed memory peaks remain bytes. No function-level attribution is inferred.',
    schema: z.object({ baseline: sampleRef, candidate: sampleRef, groups: z.array(z.enum(['cpu', 'memory', 'clr'])).min(1).default(['cpu', 'memory']) }),
    run: async input => { const [baseline, candidate] = await Promise.all([sampleSide(input.baseline), sampleSide(input.candidate)]); return compareProcessSummaries(baseline, candidate, input); } },
  { name: 'vs2015_report_inspect', readOnly: true, description: 'Inspect actual CSV headers and sample rows from VSPerfReport/PerfView/other exports. Explicit delimiter, encoding and column mapping avoid language-dependent header guesses.',
    schema: z.object(csv), run: async input => {
      const rows = await csvRows(input.path, input);
      if (!rows[input.headerRow]) throw new Error('Header row does not exist.');
      return { headers: rows[input.headerRow], rowCount: rows.length - input.headerRow - 1, sampleRows: rows.slice(input.headerRow + 1, input.headerRow + 6) };
    } },
  { name: 'vs2015_hotspots_import', description: 'Snapshot a profiler CSV and import explicitly mapped function/type hotspots. State metric, unit, attribution, process/operation scope, collector version/settings and capture exposure. Set complete=false for top-N or filtered reports.',
    schema: z.object({ ...csv, runId: id, symbolColumn: text, valueColumn: text, moduleColumn: text.optional(),
      decimalSeparator: z.enum(['.', ',']).default('.'), thousandsSeparator: z.string().max(1).default(''),
      metric: text, unit: text, valueSemantics: z.enum(['total', 'rate', 'ratio', 'gauge']), attribution: z.enum(['exclusive', 'inclusive', 'type']), collector: text,
      scope: text, settings: context.default({}), durationMs: z.number().positive(), workUnits: z.number().positive().optional(), complete: z.boolean().default(false) }),
    run: async input => {
      const source = await snapshotFile(input.runId, input.path);
      const rows = await csvRows(source.path, input);
      const { path: ignored, runId, ...options } = input;
      const report = importHotspots(rows, options);
      const artifact = await saveArtifact(runId, 'hotspots', { ...report, source });
      return { ...artifact, metric: report.metric, unit: report.unit, rowCount: report.hotspots.length, source };
    } },
  { name: 'vs2015_hotspots_compare', readOnly: true, description: 'Compare history hotspot reports only when operation, context, units, attribution, collector and settings match. Normalize by capture time or completed operations. Missing partial-report rows and zero baselines remain explicit.',
    schema: z.object({ baselineRunId: id, baselineArtifactId: id, candidateRunId: id, candidateArtifactId: id,
      normalization: z.enum(['perSecond', 'perOperation', 'none', 'total']).default('perSecond'), limit: z.number().int().min(1).max(500).default(50) }),
    run: async input => {
      const [aRun, bRun, a, b] = await Promise.all([readRun(input.baselineRunId), readRun(input.candidateRunId),
        readArtifact(input.baselineRunId, input.baselineArtifactId), readArtifact(input.candidateRunId, input.candidateArtifactId)]);
      if (a.kind !== 'hotspots' || b.kind !== 'hotspots') throw new Error('Both artifacts must be hotspot reports.');
      return compareHotspots(aRun, bRun, a.data, b.data, input);
    } },
];

export function recordingTool(catalog) {
  return { name: 'vs2015_record_action', description: 'Execute one existing MCP tool and record its actual start/end times in a history run, so concurrent sampling can be aligned to the operation. Stores argument field names and outcome only, not argument values. Does not imply performance causality.',
    schema: z.object({ runId: id, label: text, toolName: text, arguments: z.record(z.string(), z.unknown()).default({}) }),
    run: async (input, ctx) => {
      const tool = catalog.find(item => item.name === input.toolName);
      if (!tool) throw new Error('Unknown action tool; recording cannot call itself.');
      const parsed = tool.schema.parse(input.arguments), actionId = randomUUID();
      await appendEvent(input.runId, { kind: 'actionStarted', actionId, label: input.label, toolName: tool.name, argumentKeys: Object.keys(input.arguments) });
      try {
        const result = await tool.run(parsed, ctx);
        const formatted = tool.formatResult ? await tool.formatResult(result, parsed) : asToolResult(result);
        await appendEvent(input.runId, { kind: 'actionFinished', actionId, success: !formatted.isError, exitCode: result.exitCode ?? null });
        return { actionId, runId: input.runId, formatted };
      } catch (error) {
        await appendEvent(input.runId, { kind: 'actionFinished', actionId, success: false, message: error.message });
        throw error;
      }
    },
    formatResult: value => ({ ...value.formatted, structuredContent: { actionId: value.actionId, runId: value.runId, result: value.formatted.structuredContent },
      content: [{ type: 'text', text: JSON.stringify({ actionId: value.actionId, runId: value.runId }) }, ...value.formatted.content] }) };
}

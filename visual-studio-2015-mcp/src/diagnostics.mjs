import * as z from 'zod/v4';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { definitions, planMsbuild } from './tools.mjs';
import { invokeBackend } from './bridge.mjs';
import { createRun, readRun, runDirectory, saveArtifact, readArtifact, snapshotFile } from './history.mjs';
import { readJsonLines } from './samples.mjs';

const compiled = new Map();
async function loggerAssembly(input, executable, ctx) {
  const source = await readFile(new URL('../logger/DiagnosticLogger.cs', import.meta.url));
  const key = createHash('sha256').update(source).update(executable).digest('hex');
  if (!compiled.has(key)) {
    const outputDirectory = path.join(process.env.VS2015_MCP_LOGGER_CACHE || os.tmpdir(), 'vs2015-mcp-logger', randomUUID());
    if (/[;,]/.test(outputDirectory)) throw new Error('MSBuild logger assembly paths cannot contain semicolons or commas. Set VS2015_MCP_LOGGER_CACHE to a suitable directory.');
    compiled.set(key, invokeBackend({ msBuildDirectory: path.dirname(executable), outputDirectory, vsRoot: input.vsRoot ?? process.env.VS2015_MCP_ROOT,
      timeoutMs: 60000, setupTimeoutMs: 0 }, { ...ctx, script: 'Build-DiagnosticLogger.ps1' }).catch(error => { compiled.delete(key); throw error; }));
  }
  return compiled.get(key);
}

export function summarizeDiagnostics(events, parseWarnings = [], { severity, code, offset = 0, limit = 100 } = {}) {
  const footer = events.at(-1), warnings = [...parseWarnings];
  const envelope = events[0]?.kind === 'sessionStarted' && footer?.kind === 'sessionFinished' &&
    events.every((event, index) => event.schemaVersion === 1 && event.sequence === index + 1) && footer.eventsWritten === events.length && !parseWarnings.length;
  if (!envelope) warnings.push('Missing or invalid logger boundary/sequence; exact diagnostic counts are unknown.');
  const diagnostics = events.filter(event => event.kind === 'error' || event.kind === 'warning');
  const selected = diagnostics.filter(event => (!severity || event.kind === severity) && (!code || event.code === code));
  return { complete: Boolean(envelope && footer.diagnosticsComplete && footer.buildFinishedObserved),
    buildSucceeded: envelope && footer.buildFinishedObserved ? footer.succeeded : null,
    errorCount: envelope ? footer.errorCount : null, warningCount: envelope ? footer.warningCount : null,
    retainedDiagnostics: diagnostics.length, matchedDiagnostics: selected.length, offset, limit,
    diagnostics: selected.slice(offset, offset + limit),
    droppedEvents: envelope ? footer.droppedEvents : null, droppedDiagnostics: envelope ? footer.droppedDiagnostics : null,
    truncatedMessages: envelope ? footer.truncatedMessages : null,
    slowTargets: events.filter(event => event.kind === 'targetFinished' && event.durationMs >= 0)
      .sort((a, b) => b.durationMs - a.durationMs).slice(0, 20),
    warnings, timingNote: 'Target elapsed times may overlap across projects/nodes; they are not CPU time and must not be summed as build duration.' };
}
async function readDiagnostics(filename, options, expectedSha256) {
  try { const { events, warnings } = await readJsonLines(filename, { expectedSha256 }); return summarizeDiagnostics(events, warnings, options); }
  catch (error) { return summarizeDiagnostics([], [`Cannot read diagnostic log: ${error.message}`], options); }
}

const buildSchema = definitions.find(tool => tool.name === 'vs2015_msbuild').schema;
export const diagnosticDefinitions = [
  { name: 'vs2015_build_diagnostics', description: 'Run MSBuild14 with a compiled ILogger and persist language-independent error/warning codes, files, line/column spans and optional target timings. Missing/truncated logs are explicitly incomplete. Optionally link to an existing operation run.',
    schema: buildSchema.extend({ runId: z.guid().optional(), maxEvents: z.number().int().min(1).max(1000000).default(100000),
      maxMessageChars: z.number().int().min(64).max(1048576).default(32768), timings: z.boolean().default(true) }),
    run: async (input, ctx) => {
      if (input.preprocess) throw new Error('Preprocessing does not emit build diagnostics; use vs2015_msbuild for /pp.');
      const plan = planMsbuild(input);
      const resolved = await invokeBackend({ ...plan, dryRun: true }, ctx);
      const logger = await loggerAssembly(input, resolved.executable, ctx);
      const run = input.runId ? await readRun(input.runId) : await createRun({ operation: 'MSBuild', context: { project: plan.arguments[0] } });
      const logPath = path.join(runDirectory(run.id), `diagnostics-${randomUUID()}.jsonl`);
      const loggerArgument = `/logger:Vs2015.Diagnostics.DiagnosticLogger,${logger.assemblyPath};output=${Buffer.from(logPath).toString('base64')};maxEvents=${input.maxEvents};maxMessageChars=${input.maxMessageChars};timings=${input.timings}`;
      plan.arguments.push(loggerArgument);
      if (input.dryRun) return { ...resolved, arguments: plan.arguments, runId: run.id, diagnosticsPath: logPath, dryRun: true };
      let execution;
      try { execution = await invokeBackend(plan, ctx); }
      catch (error) {
        let source;
        try { source = await snapshotFile(run.id, logPath); } catch { /* startup may have produced no log */ }
        const artifact = await saveArtifact(run.id, 'build-diagnostics', { logPath: source?.path ?? logPath, source,
          executionError: error.message, diagnostics: await readDiagnostics(source?.path ?? logPath, undefined, source?.sha256) });
        return { ...artifact, error: { message: error.message } };
      }
      let source, snapshotError;
      try { source = await snapshotFile(run.id, logPath); } catch (error) { snapshotError = error.message; }
      const diagnostics = source ? await readDiagnostics(source.path, undefined, source.sha256) : summarizeDiagnostics([], [snapshotError]);
      const artifact = await saveArtifact(run.id, 'build-diagnostics', { logPath: source?.path ?? logPath, source, execution, diagnostics });
      return { ...execution, ...artifact, diagnostics,
        ...(!diagnostics.complete ? { error: { code: 'DIAGNOSTICS_INCOMPLETE', message: 'The build process returned, but a complete diagnostic log was not captured.' } } : {}) };
    } },
  { name: 'vs2015_diagnostics_read', readOnly: true, description: 'Page/filter errors and warnings from a recorded build without parsing localized console messages; retain complete counts and integrity status.',
    schema: z.object({ runId: z.guid(), artifactId: z.guid(), severity: z.enum(['error', 'warning']).optional(), code: z.string().optional(),
      offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(1000).default(100) }),
    run: async input => {
      const artifact = await readArtifact(input.runId, input.artifactId);
      if (artifact.kind !== 'build-diagnostics') throw new Error('Expected a build-diagnostics artifact.');
      const summary = await readDiagnostics(artifact.data.logPath, input, artifact.data.source?.sha256);
      if (artifact.data.executionError) { summary.complete = false; summary.warnings.push(artifact.data.executionError); }
      return { runId: input.runId, artifactId: input.artifactId, ...summary };
    } },
];

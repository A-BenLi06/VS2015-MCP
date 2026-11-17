import * as z from 'zod/v4';
import { invokeBackend } from './bridge.mjs';
import { createRun, readRun, saveArtifact } from './history.mjs';

const text = z.string().min(1).refine(value => !value.includes('\0'), 'Must not contain NUL');
const roots = { debuggerRoot: text.optional(), vsRoot: text.optional() };
const common = { ...roots, architecture: z.enum(['x86', 'x64']).describe('Match the target/dump architecture and CLR DAC.'),
  workingDirectory: text.optional(), symbolPath: text.optional(), imagePath: text.optional(), sourcePath: text.optional(),
  managedRuntime: z.enum(['none', 'clr', 'mscorwks']).default('none'),
  timeoutMs: z.number().int().min(100).max(3600000).default(120000), maxOutputChars: z.number().int().min(256).max(1048576).default(128000),
  encoding: text.optional(), dryRun: z.boolean().default(false), runId: z.guid().optional() };

async function run(operation, input, ctx) {
  const request = { ...input, operation, vsRoot: input.vsRoot ?? process.env.VS2015_MCP_ROOT };
  if (input.dryRun || operation === 'discover') return invokeBackend(request, { ...ctx, script: 'Invoke-Debug.ps1' });
  const history = input.runId ? await readRun(input.runId) : await createRun({ operation: `debug:${operation}` });
  try {
    const result = await invokeBackend(request, { ...ctx, script: 'Invoke-Debug.ps1' });
    return { ...result, ...await saveArtifact(history.id, 'debug-transcript', { operation, result }) };
  } catch (error) {
    return { error: { message: error.message }, ...await saveArtifact(history.id, 'debug-transcript', { operation, error: error.message }) };
  }
}
export const debugDefinitions = [
  { name: 'vs2015_debug_discover', readOnly: true, description: 'Discover actual VS2015/CDB/WinDbg/MDbg binaries and architectures. Report missing CLI debugging support separately from interactive VS entry points.',
    schema: z.object(roots), run: (input, ctx) => run('discover', input, ctx) },
  { name: 'vs2015_debug_dump', readOnly: true, description: 'Analyze an existing dump with CDB: exception context, all thread stacks, modules, optional Framework SOS. Save the bounded raw transcript; command errors remain visible. Requires separately installed CDB.',
    schema: z.object({ ...common, dumpPath: text }), run: (input, ctx) => run('dump', input, ctx) },
  { name: 'vs2015_debug_snapshot', readOnly: true, description: 'Noninvasive CDB snapshot of a HOST PID with threads left running (-pvr). Stacks may be inconsistent. Does not set breakpoints or step. Saves transcript; live target remains running.',
    schema: z.object({ ...common, processId: z.number().int().positive().max(2147483647) }), run: (input, ctx) => run('snapshot', input, ctx) },
  { name: 'vs2015_debug_launch_snapshot', description: 'Launch a NEW executable under CDB, capture its INITIAL LOADER breakpoint, then TERMINATE that new process. Does not run to Main or perform source stepping. Prefer dump/live snapshot for an existing workload.',
    schema: z.object({ ...common, managedRuntime: z.literal('none').default('none'), executable: text,
      arguments: z.array(z.string().refine(value => !value.includes('\0'))).max(512).default([]) }),
    run: (input, ctx) => run('launchSnapshot', input, ctx) },
  { name: 'vs2015_debug_ide_launch', description: 'Open an executable in VS2015 using devenv /DebugExe. This is an INTERACTIVE IDE handoff; no CLI session, breakpoint or step control is claimed. Application arguments must be configured in the IDE.',
    schema: z.object({ vsRoot: text.optional(), executable: text, workingDirectory: text.optional(), dryRun: z.boolean().default(false), runId: z.guid().optional() }),
    run: (input, ctx) => run('ideLaunch', input, ctx) },
];

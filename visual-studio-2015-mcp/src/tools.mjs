import * as z from 'zod/v4';
import path from 'node:path';
import { invokeBackend } from './bridge.mjs';
import { inspectSolution } from './solution.mjs';

const text = z.string().min(1).refine(value => !/[\0\r\n]/.test(value), 'Must not contain NUL or line breaks');
const argument = z.string().refine(value => !value.includes('\0'), 'Must not contain NUL');
const argv = z.array(argument).max(512);
const toolNames = ['devenv', 'msbuild', 'msbuild64', 'vstest', 'mstest', 'cl', 'link', 'lib', 'dumpbin', 'nmake', 'rc', 'mt', 'makeappx', 'signtool', 'nuget'];
const common = {
  vsRoot: text.optional().describe('Explicit VS2015 installation root; invalid paths fail without falling back.'),
  architecture: z.enum(['x86', 'amd64', 'x86_amd64', 'x86_arm', 'amd64_x86', 'amd64_arm']).default('x86'),
  workingDirectory: text.optional(),
  timeoutMs: z.number().int().min(100).max(3600000).default(120000),
  maxOutputChars: z.number().int().min(256).max(1048576).default(64000),
  encoding: text.optional().describe('Native output code page/name override; does not change tool UI language.'),
  dryRun: z.boolean().default(false).describe('Resolve tools/environment and return argv without executing the tool.'),
};

export function escapeMsbuild(value) {
  return value.replace(/[%$@();?'*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function base(input, tool, args) {
  const { vsRoot, architecture, workingDirectory, timeoutMs, maxOutputChars, encoding, dryRun } = input;
  return { operation: 'run', tool, arguments: args, vsRoot: vsRoot ?? process.env.VS2015_MCP_ROOT,
    architecture, workingDirectory, timeoutMs, maxOutputChars, encoding, dryRun };
}

export function planMsbuild(input) {
  const args = [path.resolve(input.path), '/nologo', '/nr:false'];
  if (input.targets?.length) args.push(`/t:${input.targets.join(';')}`);
  for (const [name, value] of Object.entries(input.properties ?? {})) args.push(`/p:${name}=${escapeMsbuild(value)}`);
  if (input.maxCpuCount) args.push(`/m:${input.maxCpuCount}`);
  if (input.verbosity) args.push(`/v:${input.verbosity}`);
  if (input.preprocess) args.push(`/pp:${path.resolve(input.preprocess)}`);
  args.push(...(input.additionalArguments ?? []));
  return base(input, input.hostArchitecture === 'x64' ? 'msbuild64' : 'msbuild', args);
}

export function planDevenv(input) {
  if (input.projectConfiguration && !input.project) throw new Error('projectConfiguration requires project.');
  const args = [path.resolve(input.solution), `/${input.action}`, input.configuration];
  if (input.project) args.push('/Project', input.project);
  if (input.projectConfiguration) args.push('/ProjectConfig', input.projectConfiguration);
  if (input.logFile) args.push('/Out', path.resolve(input.logFile));
  return base(input, 'devenv', args);
}

export function planVstest(input) {
  if (input.tests?.length && input.filter) throw new Error('tests and filter cannot be combined.');
  const args = input.containers.map(file => path.resolve(file));
  if (input.listTests) args.push('/ListTests');
  if (input.settings) args.push(`/Settings:${path.resolve(input.settings)}`);
  if (input.tests?.length) args.push(`/Tests:${input.tests.join(',')}`);
  if (input.filter) args.push(`/TestCaseFilter:${input.filter}`);
  if (input.platform) args.push(`/Platform:${input.platform}`);
  if (input.framework) args.push(`/Framework:${input.framework}`);
  if (input.adapterPath) args.push(`/TestAdapterPath:${path.resolve(input.adapterPath)}`);
  if (input.trx) args.push('/Logger:trx');
  args.push(...(input.additionalArguments ?? []));
  return base(input, 'vstest', args);
}

export function planMstest(input) {
  const args = input.containers.map(file => `/testcontainer:${path.resolve(file)}`);
  if (input.settings) args.push(`/testsettings:${path.resolve(input.settings)}`);
  for (const test of input.tests ?? []) args.push(`/test:${test}`);
  if (input.resultsFile) args.push(`/resultsfile:${path.resolve(input.resultsFile)}`);
  args.push(...(input.additionalArguments ?? []));
  return base(input, 'mstest', args);
}

export const definitions = [
  {
    name: 'vs2015_discover', readOnly: true,
    description: 'Find VS2015, MSBuild 14, test runners, VC and SDK executables; report missing components and versions.',
    schema: z.object({ vsRoot: text.optional(), architecture: common.architecture }),
    run: (input, ctx) => invokeBackend({ ...input, vsRoot: input.vsRoot ?? process.env.VS2015_MCP_ROOT, operation: 'discover' }, ctx),
  },
  {
    name: 'vs2015_inspect_solution', readOnly: true,
    description: 'Read actual project names and solution configurations without building or evaluating imports.',
    schema: z.object({ path: text }), run: input => inspectSolution(input.path),
  },
  {
    name: 'vs2015_tool_help', readOnly: true,
    description: 'Read the installed tool help; use this to verify switches supported by this VS/SDK update.',
    schema: z.object({ ...common, tool: z.enum(toolNames) }),
    run: (input, ctx) => invokeBackend(base(input, input.tool, [input.tool === 'nuget' ? 'help' : '/?']), ctx),
  },
  {
    name: 'vs2015_msbuild',
    description: 'Build/rebuild/clean or preprocess with MSBuild 14. Properties are an open dictionary. Projects can execute arbitrary build tasks.',
    schema: z.object({ ...common, path: text, targets: z.array(text.regex(/^[^;,:]+$/)).optional(),
      properties: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/), argument).optional(),
      hostArchitecture: z.enum(['x86', 'x64']).default('x86'), maxCpuCount: z.number().int().min(1).max(256).optional(),
      verbosity: z.enum(['quiet', 'minimal', 'normal', 'detailed', 'diagnostic']).optional(),
      preprocess: text.optional(), additionalArguments: argv.optional() }),
    run: (input, ctx) => invokeBackend(planMsbuild(input), ctx),
  },
  {
    name: 'vs2015_devenv',
    description: 'Use devenv.com for IDE-dependent solution Build/Rebuild/Clean/Deploy. /Out appends to an existing log.',
    schema: z.object({ ...common, solution: text, action: z.enum(['Build', 'Rebuild', 'Clean', 'Deploy']).default('Build'),
      configuration: text, project: text.optional(), projectConfiguration: text.optional(), logFile: text.optional() }),
    run: (input, ctx) => invokeBackend(planDevenv(input), ctx),
  },
  {
    name: 'vs2015_vstest',
    description: 'Discover/run tests using the installed VS2015 VSTest runner. Check help for version-dependent flags. Exit 0 alone does not prove tests executed.',
    schema: z.object({ ...common, containers: z.array(text).min(1), listTests: z.boolean().default(false),
      settings: text.optional(), tests: z.array(text.regex(/^[^,]+$/)).optional(), filter: text.optional(),
      platform: z.enum(['x86', 'x64', 'ARM']).optional(), framework: text.optional(), adapterPath: text.optional(),
      trx: z.boolean().default(true), additionalArguments: argv.optional() }),
    run: (input, ctx) => invokeBackend(planVstest(input), ctx),
  },
  {
    name: 'vs2015_mstest',
    description: 'Run legacy test containers using MSTest.exe. Return raw results and exit status; supply a new resultsFile for TRX.',
    schema: z.object({ ...common, containers: z.array(text).min(1), tests: z.array(text).optional(),
      settings: text.optional(), resultsFile: text.optional(), additionalArguments: argv.optional() }),
    run: (input, ctx) => invokeBackend(planMstest(input), ctx),
  },
  {
    name: 'vs2015_native',
    description: 'Execute a discovered compiler, linker, build, test or SDK tool with literal argv in the selected VS2015 environment. No shell evaluation; tool options and projects can still perform arbitrary work.',
    schema: z.object({ ...common, tool: z.enum(toolNames), arguments: argv }),
    run: (input, ctx) => invokeBackend(base(input, input.tool, input.arguments), ctx),
  },
];

export function asToolResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
    isError: Boolean(result.timedOut || result.error || (result.exitCode != null && result.exitCode !== 0)) };
}

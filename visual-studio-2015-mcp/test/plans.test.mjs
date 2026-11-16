import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { definitions, planMsbuild, planDevenv, planVstest, asToolResult } from '../src/tools.mjs';
import { inspectSolution } from '../src/solution.mjs';

test('MSBuild keeps property separators literal and accepts custom configuration names', () => {
  const parsed = definitions.find(t => t.name === 'vs2015_msbuild').schema.parse({ path: 'a b.csproj',
    properties: { Configuration: '发布 Candidate', DefineConstants: 'A;B', Custom: '%$@();,?*' } });
  const plan = planMsbuild(parsed);
  assert.ok(plan.arguments.includes('/p:DefineConstants=A%3BB'));
  assert.ok(plan.arguments.includes('/p:Configuration=发布 Candidate'));
  assert.ok(plan.arguments.includes('/p:Custom=%25%24%40%28%29%3B%2C%3F%2A'));
  assert.ok(plan.arguments.includes('/nr:false'));
  assert.equal(plan.tool, 'msbuild');
});

test('typed paths resolve against the requested working directory', () => {
  const workingDirectory = path.resolve('separate work');
  const plan = planMsbuild({ workingDirectory, path: 'app.csproj', preprocess: 'imports.xml' });
  assert.equal(plan.arguments[0], path.join(workingDirectory, 'app.csproj'));
  assert.ok(plan.arguments.includes(`/pp:${path.join(workingDirectory, 'imports.xml')}`));
  const testPlan = planVstest({ workingDirectory, containers: ['tests.dll'], settings: 'test.runsettings' });
  assert.equal(testPlan.arguments[0], path.join(workingDirectory, 'tests.dll'));
  assert.ok(testPlan.arguments.includes(`/Settings:${path.join(workingDirectory, 'test.runsettings')}`));
});

test('devenv and vstest reject contradictory arguments', () => {
  assert.throws(() => planDevenv({ solution: 'x.sln', projectConfiguration: 'Release' }), /requires project/);
  assert.throws(() => planVstest({ containers: ['x.dll'], tests: ['one'], filter: 'Name=two' }), /cannot be combined/);
});

test('native arguments preserve quotes, metacharacters and empty values', () => {
  const input = { tool: 'cl', arguments: ['', 'a & b.cpp', '"quoted"', '$HOME', '%PATH%'] };
  const parsed = definitions.find(t => t.name === 'vs2015_native').schema.parse(input);
  assert.deepEqual(parsed.arguments, input.arguments);
  assert.throws(() => definitions.find(t => t.name === 'vs2015_native').schema.parse({ tool: 'cmd', arguments: [] }));
});

test('static solution inspection reads actual Unicode configurations and project names', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vs2015-sln-'));
  try {
    const file = path.join(dir, 'sample.sln');
    const content = 'Microsoft Visual Studio Solution File, Format Version 12.00\r\n' +
      'Project("{type}") = "项目, UI", "folder\\app.csproj", "{id}"\r\nEndProject\r\n' +
      'GlobalSection(SolutionConfigurationPlatforms) = preSolution\r\n发布|Any CPU = 发布|Any CPU\r\nEndGlobalSection';
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
    const result = await inspectSolution(file);
    assert.deepEqual(result.configurations, ['发布|Any CPU']);
    assert.equal(result.projects[0].name, '项目, UI');
    assert.equal(result.evaluated, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('nonzero exit codes and timeouts remain MCP tool errors', () => {
  assert.equal(asToolResult({ exitCode: 1 }).isError, true);
  assert.equal(asToolResult({ timedOut: true, exitCode: 0 }).isError, true);
  assert.equal(asToolResult({ exitCode: 0 }).isError, false);
  assert.equal(asToolResult({ dryRun: true }).isError, false);
});

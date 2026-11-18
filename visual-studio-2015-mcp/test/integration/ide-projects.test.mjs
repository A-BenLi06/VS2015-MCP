import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('IDE configuration guards, nested projects and project builds use actual state', {
  skip: process.platform !== 'win32' || !process.env.VS2015_TEST_IDE_MANIFEST, timeout: 180000,
}, async t => {
  const filename = path.resolve(process.env.VS2015_TEST_IDE_MANIFEST);
  const relative = path.relative(os.tmpdir(), filename);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
  const fixture = JSON.parse(await readFile(filename, 'utf8'));
  const client = new Client({ name: 'ide-project-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: process.env }));
  const raw = (name, args) => client.callTool({ name, arguments: args }, { timeout: 90000, signal: t.signal });
  const call = async (name, args) => { const result = await raw(name, args); assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent; };
  let sessionId, original, restoreProperty;
  try {
    ({ sessionId } = await call('vs2015_attach', { processId: fixture.processId, expectedStartTimeUtc: fixture.startTimeUtc }));
    original = await call('vs2015_solution_configurations', { sessionId });
    assert.equal(path.resolve((await call('vs2015_solution_status', { sessionId })).fullName).toLowerCase(), path.resolve(fixture.solution).toLowerCase());
    const nested = original.projects.find(project => project.depth > 0 && !project.solutionFolder);
    assert.ok(nested, 'This test requires an owned fixture with a real project inside a solution folder');
    assert.ok(original.projects.some(project => project.uniqueName === nested.parentUniqueName && project.solutionFolder));
    const other = original.configurations.find(config => config.name !== original.activeConfiguration || config.platform !== original.activePlatform);
    assert.ok(other);
    const changed = await call('vs2015_solution_configure', { sessionId, configuration: other.name, platform: other.platform,
      startupProjects: original.startupProjects, expectedConfigurationToken: original.configurationToken });
    assert.equal(changed.activeConfiguration, other.name); assert.equal(changed.activePlatform, other.platform);
    const stale = await raw('vs2015_solution_configure', { sessionId, configuration: original.activeConfiguration,
      platform: original.activePlatform, expectedConfigurationToken: original.configurationToken });
    assert.equal(stale.structuredContent.error.code, 'CONFIGURATION_CONFLICT');
    let current = await call('vs2015_solution_configure', { sessionId, configuration: original.activeConfiguration,
      platform: original.activePlatform, startupProjects: original.startupProjects, expectedConfigurationToken: changed.configurationToken });
    const folder = current.projects.find(project => project.solutionFolder);
    const rejected = await raw('vs2015_solution_configure', { sessionId, configuration: current.activeConfiguration,
      platform: current.activePlatform, startupProjects: [folder.uniqueName], expectedConfigurationToken: current.configurationToken });
    assert.equal(rejected.structuredContent.error.code, 'PROJECT_NOT_FOUND');
    const property = await call('vs2015_project_properties', { sessionId, projectUniqueName: original.startupProjects[0], propertyName: 'StartArguments' });
    const value = property.properties[0].value;
    restoreProperty = { projectUniqueName: original.startupProjects[0], propertyName: 'StartArguments', value };
    const set = await call('vs2015_project_property_set', { sessionId, ...restoreProperty, expectedValue: value,
      value: '--owned-validation', expectedConfigurationToken: current.configurationToken });
    assert.equal(set.value, '--owned-validation');
    const conflict = await raw('vs2015_project_property_set', { sessionId, ...restoreProperty, expectedValue: value, expectedConfigurationToken: set.configurationToken });
    assert.equal(conflict.structuredContent.error.code, 'PROPERTY_CONFLICT');
    await call('vs2015_project_property_set', { sessionId, ...restoreProperty, expectedValue: '--owned-validation', expectedConfigurationToken: set.configurationToken });
    restoreProperty = null;
    current = await call('vs2015_solution_configurations', { sessionId });
    const build = await call('vs2015_project_build', { sessionId, projectUniqueName: nested.uniqueName, expectedConfigurationToken: current.configurationToken });
    const deadline = Date.now() + 60000; let status;
    do {
      await new Promise(resolve => setTimeout(resolve, 200));
      status = await call('vs2015_build_status', { sessionId, buildId: build.buildId });
      assert.ok(Date.now() < deadline, JSON.stringify(status));
    } while (!status.terminal);
    assert.equal(status.complete, true); assert.equal(status.state, 'succeeded');
    assert.equal(status.projectUniqueName, nested.uniqueName); assert.equal(status.scope, 'vsBuildScopeProject');
    assert.equal(status.configuration, original.activeConfiguration); assert.equal(status.platform, original.activePlatform);
  } finally {
    if (sessionId) {
      const current = await call('vs2015_solution_configurations', { sessionId }).catch(() => null);
      if (current && restoreProperty) {
        const property = await call('vs2015_project_properties', { sessionId, projectUniqueName: restoreProperty.projectUniqueName, propertyName: restoreProperty.propertyName }).catch(() => null);
        if (property) await call('vs2015_project_property_set', { sessionId, ...restoreProperty, expectedValue: property.properties[0].value, expectedConfigurationToken: current.configurationToken }).catch(() => {});
      }
      if (current && original) await call('vs2015_solution_configure', { sessionId, configuration: original.activeConfiguration,
        platform: original.activePlatform, startupProjects: original.startupProjects, expectedConfigurationToken: current.configurationToken }).catch(() => {});
      await call('vs2015_detach', { sessionId }).catch(() => {});
    }
    await client.close();
  }
});

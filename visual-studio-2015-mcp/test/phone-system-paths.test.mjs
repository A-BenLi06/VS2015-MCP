import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixtureTestTimeoutMs, runPhoneFixture } from './helpers/windows-phone-fixture.mjs';

test('shared phone SDK discovery uses real Windows folders without OS directory environment variables', { skip: process.platform !== 'win32', timeout: fixtureTestTimeoutMs }, async t => {
  const result = await runPhoneFixture('Test-PhoneSystemPaths', t);
  assert.equal(result.passed, true);
  assert.equal(result.environmentStillAbsent, true);
  assert.ok(path.isAbsolute(result.windows) && path.isAbsolute(result.programFilesX86));
});

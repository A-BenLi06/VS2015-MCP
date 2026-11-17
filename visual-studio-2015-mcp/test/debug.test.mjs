import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDebugResult } from '../src/debug.mjs';
import { asToolResult } from '../src/tools.mjs';

test('CDB startup can exit zero before executing diagnostics', () => {
  const result = classifyDebugResult({ exitCode: 0, reportCompletion: 'not-confirmed', stdout: 'startup rejected' });
  assert.equal(result.error.code, 'DEBUG_REPORT_INCOMPLETE');
  assert.equal(asToolResult(result).isError, true);
  assert.equal(result.stdout, 'startup rejected');
  assert.equal(classifyDebugResult({ exitCode: 0, reportCompletion: 'completed' }).error, undefined);
});

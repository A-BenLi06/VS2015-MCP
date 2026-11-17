import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRun, readArtifact } from '../src/history.mjs';
import { saveProfilerResult } from '../src/profiler.mjs';

test('profiler history stores the same final failure state as the immediate result', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v15-profiler-state-'));
  const old = process.env.VS2015_MCP_HISTORY; process.env.VS2015_MCP_HISTORY = directory;
  try {
    const run = await createRun({ operation: 'capture' });
    for (const [operation, result] of [
      ['capture', { status: 'partial', execution: { exitCode: 0, timedOut: false } }],
      ['report', { execution: { exitCode: 17, timedOut: true } }],
      ['capture', { status: 'cancelled', error: { code: 'CANCELLED', message: 'owned capture stopped' } }],
    ]) {
      const ref = await saveProfilerResult(run.id, operation, result);
      const saved = await readArtifact(run.id, ref.artifactId);
      assert.deepEqual(saved.data.result, result);
      if (result.status === 'partial') assert.equal(saved.data.result.error.code, 'PROFILE_INCOMPLETE');
    }
  } finally {
    if (old === undefined) delete process.env.VS2015_MCP_HISTORY; else process.env.VS2015_MCP_HISTORY = old;
    await rm(directory, { recursive: true, force: true });
  }
});

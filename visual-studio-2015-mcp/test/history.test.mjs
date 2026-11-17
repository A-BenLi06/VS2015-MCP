import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRun, listRuns, appendEvent, timeline, saveArtifact, readArtifact, runDirectory, parseCsv, importHotspots, compareHotspots } from '../src/history.mjs';

test('history preserves concurrent action events and immutable artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vs-history-'));
  try {
    const run = await createRun({ operation: '打开列表', context: { target: 'fixture' } }, root);
    await Promise.all(Array.from({ length: 12 }, (_, i) => appendEvent(run.id, { kind: 'mark', label: String(i) }, root)));
    assert.equal((await timeline(run.id, root)).events.length, 12);
    const artifact = await saveArtifact(run.id, 'test', { value: 3 }, root);
    assert.equal((await readArtifact(run.id, artifact.artifactId, root)).data.value, 3);
    assert.throws(() => runDirectory('../escape', root), /Invalid/);
    await Promise.all(Array.from({ length: 20 }, async () => { await createRun({ operation: 'concurrent' }, root); await listRuns({}, root); }));
    assert.equal((await listRuns({ limit: 100 }, root)).length, 21);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CSV import uses explicit localized columns and numeric conventions', () => {
  const rows = parseCsv('\uFEFF"函数";"模块";"字节"\r\n"A;B";"程序集";"1.234,5"\r\n"multi\nline";"m";"0"', ';');
  const imported = importHotspots(rows, { symbolColumn: '函数', moduleColumn: '模块', valueColumn: '字节', decimalSeparator: ',', thousandsSeparator: '.' });
  assert.equal(imported.hotspots[0].value, 1234.5);
  assert.equal(imported.hotspots[1].symbol, 'multi\nline');
  assert.throws(() => parseCsv('"incomplete'), /Unterminated/);
  assert.throws(() => importHotspots([['x', 'v'], ['a', 'NaN']], { symbolColumn: 'x', valueColumn: 'v' }), /Invalid numeric/);
});

test('comparisons normalize exposure and reject incompatible measurements', () => {
  const run = { operation: 'load', context: { target: 'fixture' } };
  const baseline = { metric: 'cpu', unit: 'samples', valueSemantics: 'total', attribution: 'exclusive', collector: 'fixture', scope: 'process', durationMs: 1000, complete: true,
    hotspots: [{ symbol: 'A', module: 'm', value: 10 }] };
  const candidate = { ...baseline, durationMs: 2000, hotspots: [{ symbol: 'A', module: 'm', value: 30 }, { symbol: 'B', module: 'm', value: 2 }] };
  const result = compareHotspots(run, run, baseline, candidate);
  assert.equal(result.rows.find(row => row.symbol === 'A').delta, 5);
  assert.equal(result.rows.find(row => row.symbol === 'B').percentChange, null);
  assert.equal(compareHotspots(run, run, baseline, { ...candidate, unit: 'bytes' }).comparable, false);
  assert.equal(compareHotspots(run, { ...run, operation: 'other' }, baseline, candidate).comparable, false);
  const partial = compareHotspots(run, run, { ...baseline, complete: false }, candidate);
  assert.equal(partial.rows.find(row => row.symbol === 'B').baseline, null);
  const ratio = { ...baseline, unit: '%', valueSemantics: 'ratio' };
  assert.throws(() => compareHotspots(run, run, ratio, { ...ratio, durationMs: 2000 }), /normalization=none/);
  assert.equal(compareHotspots(run, run, ratio, { ...ratio, durationMs: 2000 }, { normalization: 'none' }).rows[0].delta, 0);
  const repeated = { ...ratio, hotspots: [...ratio.hotspots, ...ratio.hotspots] };
  assert.throws(() => compareHotspots(run, run, repeated, repeated, { normalization: 'none' }), /Duplicate/);
});

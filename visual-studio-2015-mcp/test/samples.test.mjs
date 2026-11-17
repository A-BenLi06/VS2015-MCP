import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSamples } from '../src/samples.mjs';

const sample = (time, cpu, allocated, count) => ({ kind: 'sample', timestampUtc: new Date(time).toISOString(), elapsedMs: time,
  cpuTotalMs: cpu, privateBytes: time + 100, workingSetBytes: 200,
  clr: { instance: 'fixture', allocatedBytesCounter: allocated, gen0Collections: count, gen1Collections: 0, gen2Collections: 0, heapBytes: 300, largeObjectHeapBytes: 0 } });
test('CPU uses measured elapsed time; CLR deltas are not summed cumulative values', () => {
  const events = [{ kind: 'start', logicalProcessors: 4 }, sample(0, 100, 1000, 2), sample(2000, 1100, 5000, 4), { kind: 'end', complete: true }];
  const result = summarizeSamples(events);
  assert.equal(result.cpuOneCorePercent, 50);
  assert.equal(result.cpuHotIntervals[0].cpuMachinePercent, 12.5);
  assert.equal(result.clr.allocatedBytes, 4000);
  assert.equal(result.clr.gen0Collections, 2);
});
test('partial captures, counter resets and narrow operation windows remain explicit', () => {
  const events = [sample(0, 100, 1000, 2), sample(1000, 200, 0, 0)];
  const result = summarizeSamples(events);
  assert.equal(result.complete, false);
  assert.equal(result.clr, null);
  assert.ok(result.warnings.some(warning => warning.includes('reset')));
  const empty = summarizeSamples(events, { startUtc: new Date(200).toISOString(), endUtc: new Date(800).toISOString() });
  assert.equal(empty.intervalCount, 0);
  assert.equal(empty.cpuOneCorePercent, null);
});

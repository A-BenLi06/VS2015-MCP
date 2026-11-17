import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSamples } from '../src/samples.mjs';

const sample = (time, cpu, allocated, count) => ({ kind: 'sample', timestampUtc: new Date(time).toISOString(), elapsedMs: time,
  cpuTotalMs: cpu, privateBytes: time + 100, workingSetBytes: 200,
  clr: { instance: 'fixture', timestampUtc: new Date(time).toISOString(), allocatedBytesCounter: allocated, gen0Collections: count, gen1Collections: 0, gen2Collections: 0, heapBytes: 300, largeObjectHeapBytes: 0 } });
test('CPU uses measured elapsed time; CLR deltas are not summed cumulative values', () => {
  const events = [{ kind: 'start', schemaVersion: 1, logicalProcessors: 4 }, sample(0, 100, 1000, 2), sample(2000, 1100, 5000, 4), { kind: 'end', complete: true, samples: 2 }];
  const result = summarizeSamples(events);
  assert.equal(result.cpuOneCorePercent, 50);
  assert.equal(result.cpuHotIntervals[0].cpuMachinePercent, 12.5);
  assert.equal(result.clr.allocatedBytes, 4000);
  assert.equal(result.clr.gen0Collections, 2);
});
test('first memory peak, delayed CLR timestamps and corrupt samples are handled', () => {
  const a = sample(0, 10, 100, 1), b = sample(1000, 20, 200, 2);
  a.privateBytes = 1000; b.privateBytes = 100;
  a.clr.timestampUtc = new Date(500).toISOString(); b.clr.timestampUtc = new Date(2000).toISOString();
  const events = [{ kind: 'start', schemaVersion: 1, logicalProcessors: 4 }, a, b, { kind: 'end', samples: 2, complete: true }];
  assert.equal(summarizeSamples(events).peakPrivateBytes, 1000);
  assert.equal(summarizeSamples(events, { startUtc: new Date(0).toISOString(), endUtc: new Date(1500).toISOString() }).clr, null);
  delete b.cpuTotalMs;
  const bad = summarizeSamples(events); assert.equal(bad.complete, false); assert.equal(bad.cpuMs, 0);
  assert.ok(bad.warnings.some(warning => warning.includes('Invalid process')));
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

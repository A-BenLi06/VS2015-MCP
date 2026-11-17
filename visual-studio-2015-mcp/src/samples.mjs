import { readFile, stat } from 'node:fs/promises';

export async function readJsonLines(filename) {
  if ((await stat(filename)).size > 128 * 1024 * 1024) throw new Error('JSONL capture exceeds the 128 MiB analysis limit.');
  const text = await readFile(filename, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const events = [], warnings = [];
  for (let index = 0; index < lines.length; index++) {
    try { events.push(JSON.parse(lines[index])); }
    catch (error) { warnings.push(`Invalid JSON at line ${index + 1}: ${error.message}`); }
  }
  return { events, warnings };
}

export function summarizeSamples(events, { startUtc, endUtc, top = 10 } = {}) {
  const header = events.find(event => event.kind === 'start');
  const footer = events.at(-1)?.kind === 'end' ? events.at(-1) : null;
  const samples = events.filter(event => event.kind === 'sample');
  const intervals = [], warnings = [...(footer?.warnings ?? [])];
  const start = startUtc ? Date.parse(startUtc) : -Infinity, end = endUtc ? Date.parse(endUtc) : Infinity;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new Error('Invalid operation time window.');
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (Date.parse(a.timestampUtc) < start || Date.parse(b.timestampUtc) > end) continue;
    const elapsedMs = b.elapsedMs - a.elapsedMs, cpuMs = b.cpuTotalMs - a.cpuTotalMs;
    if (!(elapsedMs > 0) || cpuMs < 0) { warnings.push('Non-monotonic process counters; interval omitted.'); continue; }
    const interval = { startUtc: a.timestampUtc, endUtc: b.timestampUtc, elapsedMs, cpuMs,
      cpuOneCorePercent: cpuMs / elapsedMs * 100, cpuMachinePercent: cpuMs / elapsedMs / (header?.logicalProcessors || 1) * 100,
      privateBytes: b.privateBytes, privateBytesDelta: b.privateBytes - a.privateBytes, workingSetBytes: b.workingSetBytes,
      clr: null };
    if (a.clr && b.clr && a.clr.instance === b.clr.instance) {
      const keys = ['allocatedBytesCounter', 'gen0Collections', 'gen1Collections', 'gen2Collections'];
      const delta = Object.fromEntries(keys.map(key => [key, b.clr[key] - a.clr[key]]));
      if (Object.values(delta).every(value => Number.isFinite(value) && value >= 0)) {
        interval.clr = { allocatedBytes: delta.allocatedBytesCounter, gen0Collections: delta.gen0Collections,
          gen1Collections: delta.gen1Collections, gen2Collections: delta.gen2Collections,
          heapBytes: b.clr.heapBytes, largeObjectHeapBytes: b.clr.largeObjectHeapBytes };
      } else warnings.push('CLR counter reset/wrap or missing value; interval CLR deltas omitted.');
    }
    intervals.push(interval);
  }
  if (!footer) warnings.push('Missing capture footer: interrupted capture, not a complete measurement.');
  if (startUtc || endUtc) warnings.push('Only whole sampling intervals within the action are included; short actions may have no samples. This is temporal association, not causal attribution.');
  const elapsedMs = intervals.reduce((sum, item) => sum + item.elapsedMs, 0);
  const cpuMs = intervals.reduce((sum, item) => sum + item.cpuMs, 0);
  const clrIntervals = intervals.filter(item => item.clr);
  return { identity: header?.identity, complete: Boolean(footer?.complete), requestedWindow: { startUtc, endUtc },
    sampleCount: samples.length, intervalCount: intervals.length, measuredIntervalMs: elapsedMs, cpuMs,
    cpuOneCorePercent: elapsedMs ? cpuMs / elapsedMs * 100 : null,
    peakPrivateBytes: intervals.length ? Math.max(...intervals.map(item => item.privateBytes)) : null,
    peakWorkingSetBytes: intervals.length ? Math.max(...intervals.map(item => item.workingSetBytes)) : null,
    clr: clrIntervals.length ? { observedIntervals: clrIntervals.length,
      allocatedBytes: clrIntervals.reduce((sum, item) => sum + item.clr.allocatedBytes, 0),
      gen0Collections: clrIntervals.reduce((sum, item) => sum + item.clr.gen0Collections, 0),
      gen1Collections: clrIntervals.reduce((sum, item) => sum + item.clr.gen1Collections, 0),
      gen2Collections: clrIntervals.reduce((sum, item) => sum + item.clr.gen2Collections, 0) } : null,
    cpuHotIntervals: [...intervals].sort((a, b) => b.cpuOneCorePercent - a.cpuOneCorePercent).slice(0, top),
    memoryGrowthIntervals: [...intervals].sort((a, b) => b.privateBytesDelta - a.privateBytesDelta).slice(0, top),
    warnings: [...new Set(warnings)],
    limitations: ['Process counters do not identify function or allocation-stack hotspots.', 'CLR counters apply to .NET Framework and update at GC boundaries. Gen2 collections include lower-generation collection counts.', 'Private bytes, working set, allocated bytes and retained managed heap are different measurements.'] };
}

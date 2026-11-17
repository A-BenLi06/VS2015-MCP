import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function readJsonLines(filename, { expectedSha256 } = {}) {
  if ((await stat(filename)).size > 128 * 1024 * 1024) throw new Error('JSONL capture exceeds the 128 MiB analysis limit.');
  const bytes = await readFile(filename);
  if (expectedSha256 && createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('Capture snapshot hash changed; historical evidence is no longer intact.');
  const text = bytes.toString('utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const events = [], warnings = [];
  for (let index = 0; index < lines.length; index++) {
    try { events.push(JSON.parse(lines[index])); }
    catch (error) { warnings.push(`Invalid JSON at line ${index + 1}: ${error.message}`); }
  }
  return { events, warnings };
}

export function summarizeSamples(events, { startUtc, endUtc, top = 10, parseWarnings = [] } = {}) {
  const header = events[0]?.kind === 'start' ? events[0] : null;
  const footer = events.at(-1)?.kind === 'end' ? events.at(-1) : null;
  const rawSamples = events.filter(event => event.kind === 'sample');
  let valid = Boolean(header?.schemaVersion === 1 && Number.isInteger(header.logicalProcessors) && header.logicalProcessors > 0 && footer?.samples === rawSamples.length && !parseWarnings.length);
  const intervals = [], warnings = [...parseWarnings, ...(footer?.warnings ?? [])];
  const samples = rawSamples.filter(sample => {
    const good = Number.isFinite(Date.parse(sample.timestampUtc)) && ['elapsedMs', 'cpuTotalMs', 'privateBytes', 'workingSetBytes'].every(key => Number.isFinite(sample[key]) && sample[key] >= 0);
    if (!good) { valid = false; warnings.push('Invalid process sample fields; sample omitted.'); }
    return good;
  });
  const start = startUtc ? Date.parse(startUtc) : -Infinity, end = endUtc ? Date.parse(endUtc) : Infinity;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new Error('Invalid operation time window.');
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (Date.parse(a.timestampUtc) < start || Date.parse(b.timestampUtc) > end) continue;
    const elapsedMs = b.elapsedMs - a.elapsedMs, cpuMs = b.cpuTotalMs - a.cpuTotalMs;
    if (!(elapsedMs > 0) || cpuMs < 0 || Date.parse(b.timestampUtc) <= Date.parse(a.timestampUtc)) { valid = false; warnings.push('Non-monotonic process counters; interval omitted.'); continue; }
    const interval = { startUtc: a.timestampUtc, endUtc: b.timestampUtc, elapsedMs, cpuMs,
      cpuOneCorePercent: cpuMs / elapsedMs * 100, cpuMachinePercent: cpuMs / elapsedMs / (header?.logicalProcessors || 1) * 100,
      privateBytes: b.privateBytes, privateBytesDelta: b.privateBytes - a.privateBytes, workingSetBytes: b.workingSetBytes,
      clr: null };
    if (a.clr && b.clr && a.clr.instance === b.clr.instance) {
      const clrStart = Date.parse(a.clr.timestampUtc), clrEnd = Date.parse(b.clr.timestampUtc);
      const keys = ['allocatedBytesCounter', 'gen0Collections', 'gen1Collections', 'gen2Collections'];
      const delta = Object.fromEntries(keys.map(key => [key, b.clr[key] - a.clr[key]]));
      if (Number.isFinite(clrStart) && Number.isFinite(clrEnd) && clrEnd > clrStart && clrStart >= start && clrEnd <= end && Object.values(delta).every(value => Number.isFinite(value) && value >= 0)) {
        interval.clr = { allocatedBytes: delta.allocatedBytesCounter, gen0Collections: delta.gen0Collections,
          gen1Collections: delta.gen1Collections, gen2Collections: delta.gen2Collections,
          elapsedMs: clrEnd - clrStart, heapBytes: b.clr.heapBytes, largeObjectHeapBytes: b.clr.largeObjectHeapBytes };
      } else warnings.push('CLR counter reset/wrap, missing timestamp/value, or interval outside the operation window; CLR deltas omitted.');
    }
    intervals.push(interval);
  }
  if (!footer) warnings.push('Missing capture footer: interrupted capture, not a complete measurement.');
  if (!valid) warnings.push('Capture metadata, sample count or data integrity could not be verified.');
  if (startUtc || endUtc) warnings.push('Only whole sampling intervals within the action are included; short actions may have no samples. This is temporal association, not causal attribution.');
  const elapsedMs = intervals.reduce((sum, item) => sum + item.elapsedMs, 0);
  const cpuMs = intervals.reduce((sum, item) => sum + item.cpuMs, 0);
  const clrIntervals = intervals.filter(item => item.clr);
  const memorySamples = samples.filter(sample => Date.parse(sample.timestampUtc) >= start && Date.parse(sample.timestampUtc) <= end);
  return { identity: header?.identity, captureFinished: Boolean(footer), complete: Boolean(valid && footer?.complete), requestedWindow: { startUtc, endUtc },
    sampleCount: samples.length, intervalCount: intervals.length, measuredIntervalMs: elapsedMs, cpuMs,
    cpuOneCorePercent: elapsedMs ? cpuMs / elapsedMs * 100 : null,
    peakPrivateBytes: memorySamples.length ? Math.max(...memorySamples.map(item => item.privateBytes)) : null,
    peakWorkingSetBytes: memorySamples.length ? Math.max(...memorySamples.map(item => item.workingSetBytes)) : null,
    clr: clrIntervals.length ? { observedIntervals: clrIntervals.length, measuredIntervalMs: clrIntervals.reduce((sum, item) => sum + item.clr.elapsedMs, 0),
      allocatedBytes: clrIntervals.reduce((sum, item) => sum + item.clr.allocatedBytes, 0),
      gen0Collections: clrIntervals.reduce((sum, item) => sum + item.clr.gen0Collections, 0),
      gen1Collections: clrIntervals.reduce((sum, item) => sum + item.clr.gen1Collections, 0),
      gen2Collections: clrIntervals.reduce((sum, item) => sum + item.clr.gen2Collections, 0) } : null,
    cpuHotIntervals: [...intervals].sort((a, b) => b.cpuOneCorePercent - a.cpuOneCorePercent).slice(0, top),
    memoryGrowthIntervals: [...intervals].sort((a, b) => b.privateBytesDelta - a.privateBytesDelta).slice(0, top),
    warnings: [...new Set(warnings)],
    limitations: ['Process counters do not identify function or allocation-stack hotspots.', 'CLR counters apply to .NET Framework and update at GC boundaries. Gen2 collections include lower-generation collection counts.', 'Private bytes, working set, allocated bytes and retained managed heap are different measurements.'] };
}

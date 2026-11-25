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
  const intervals = [], clrIntervals = [], warnings = [...parseWarnings, ...(footer?.warnings ?? [])];
  let clrMissingIntervals = 0, clrRejectedIntervals = 0;
  const samples = rawSamples.filter(sample => {
    const good = Number.isFinite(Date.parse(sample.timestampUtc)) && ['elapsedMs', 'cpuTotalMs', 'privateBytes', 'workingSetBytes'].every(key => Number.isFinite(sample[key]) && sample[key] >= 0);
    if (!good) { valid = false; warnings.push('Invalid process sample fields; sample omitted.'); }
    return good;
  });
  const start = startUtc ? Date.parse(startUtc) : -Infinity, end = endUtc ? Date.parse(endUtc) : Infinity;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new Error('Invalid operation time window.');
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const cpuInWindow = Date.parse(a.timestampUtc) >= start && Date.parse(b.timestampUtc) <= end;
    const elapsedMs = b.elapsedMs - a.elapsedMs, cpuMs = b.cpuTotalMs - a.cpuTotalMs;
    if (!(elapsedMs > 0) || cpuMs < 0 || Date.parse(b.timestampUtc) <= Date.parse(a.timestampUtc)) { valid = false; warnings.push('Non-monotonic process counters; interval omitted.'); continue; }
    const interval = { startUtc: a.timestampUtc, endUtc: b.timestampUtc, elapsedMs, cpuMs,
      cpuOneCorePercent: cpuMs / elapsedMs * 100,
      cpuMachinePercent: Number.isInteger(header?.logicalProcessors) && header.logicalProcessors > 0 ? cpuMs / elapsedMs / header.logicalProcessors * 100 : null,
      privateBytes: b.privateBytes, privateBytesDelta: b.privateBytes - a.privateBytes, workingSetBytes: b.workingSetBytes,
      clr: null };
    if (a.clr && b.clr) {
      const clrStart = Date.parse(a.clr.timestampUtc), clrEnd = Date.parse(b.clr.timestampUtc);
      const validBounds = Number.isFinite(clrStart) && Number.isFinite(clrEnd) && clrEnd > clrStart;
      const clrInWindow = validBounds && clrStart >= start && clrEnd <= end;
      const keys = ['allocatedBytesCounter', 'gen0Collections', 'gen1Collections', 'gen2Collections'];
      const delta = Object.fromEntries(keys.map(key => [key, b.clr[key] - a.clr[key]]));
      const validCounters = a.clr.instance === b.clr.instance &&
        keys.every(key => Number.isFinite(a.clr[key]) && a.clr[key] >= 0 && Number.isFinite(b.clr[key]) && b.clr[key] >= 0) &&
        Object.values(delta).every(value => Number.isFinite(value) && value >= 0);
      if (clrInWindow && validCounters) {
        interval.clr = { allocatedBytes: delta.allocatedBytesCounter, gen0Collections: delta.gen0Collections,
          gen1Collections: delta.gen1Collections, gen2Collections: delta.gen2Collections,
          startUtc: a.clr.timestampUtc, endUtc: b.clr.timestampUtc,
          elapsedMs: clrEnd - clrStart, heapBytes: b.clr.heapBytes, largeObjectHeapBytes: b.clr.largeObjectHeapBytes };
        // A CLR measurement can be inside the action even when the CPU interval
        // starts before it. Never gate this accumulator on cpuInWindow.
        clrIntervals.push(interval.clr);
      } else if ((clrInWindow && !validCounters) || (cpuInWindow && !validBounds)) {
        clrRejectedIntervals++;
        warnings.push('CLR counter reset/wrap, changed instance, or missing timestamp/value; CLR interval omitted.');
      }
    } else if (cpuInWindow) clrMissingIntervals++;
    if (cpuInWindow) intervals.push(interval);
  }
  if (!footer) warnings.push('Missing capture footer: interrupted capture, not a complete measurement.');
  if (!valid) warnings.push('Capture metadata, sample count or data integrity could not be verified.');
  if (startUtc || endUtc) warnings.push('Only whole sampling intervals within the action are included; short actions may have no samples. This is temporal association, not causal attribution.');
  const elapsedMs = intervals.reduce((sum, item) => sum + item.elapsedMs, 0);
  const cpuDataSufficient = intervals.length > 0;
  const cpuMs = cpuDataSufficient ? intervals.reduce((sum, item) => sum + item.cpuMs, 0) : null;
  if (!cpuDataSufficient) warnings.push('CPU data is insufficient: no valid measurement interval was observed.');
  const memorySamples = samples.filter(sample => Date.parse(sample.timestampUtc) >= start && Date.parse(sample.timestampUtc) <= end);
  return { identity: header?.identity, captureFinished: Boolean(footer), complete: Boolean(valid && footer?.complete && cpuDataSufficient), cpuDataSufficient, requestedWindow: { startUtc, endUtc },
    sampleCount: samples.length, memorySampleCount: memorySamples.length, intervalCount: intervals.length, measuredIntervalMs: elapsedMs, cpuMs,
    logicalProcessors: Number.isInteger(header?.logicalProcessors) && header.logicalProcessors > 0 ? header.logicalProcessors : null,
    cpuOneCorePercent: elapsedMs ? cpuMs / elapsedMs * 100 : null,
    cpuMachinePercent: elapsedMs && Number.isInteger(header?.logicalProcessors) && header.logicalProcessors > 0 ? cpuMs / elapsedMs / header.logicalProcessors * 100 : null,
    peakPrivateBytes: memorySamples.length ? Math.max(...memorySamples.map(item => item.privateBytes)) : null,
    peakWorkingSetBytes: memorySamples.length ? Math.max(...memorySamples.map(item => item.workingSetBytes)) : null,
    clr: clrIntervals.length ? {
      complete: Boolean(valid && footer?.complete && clrMissingIntervals === 0 && clrRejectedIntervals === 0),
      observedIntervals: clrIntervals.length, measuredIntervalMs: clrIntervals.reduce((sum, item) => sum + item.elapsedMs, 0),
      firstSampleUtc: clrIntervals[0].startUtc, lastSampleUtc: clrIntervals.at(-1).endUtc,
      allocatedBytes: clrIntervals.reduce((sum, item) => sum + item.allocatedBytes, 0),
      gen0Collections: clrIntervals.reduce((sum, item) => sum + item.gen0Collections, 0),
      gen1Collections: clrIntervals.reduce((sum, item) => sum + item.gen1Collections, 0),
      gen2Collections: clrIntervals.reduce((sum, item) => sum + item.gen2Collections, 0) } : null,
    clrCoverage: { observedIntervals: clrIntervals.length, missingIntervals: clrMissingIntervals, rejectedIntervals: clrRejectedIntervals },
    cpuHotIntervals: [...intervals].sort((a, b) => b.cpuOneCorePercent - a.cpuOneCorePercent).slice(0, top),
    memoryGrowthIntervals: [...intervals].sort((a, b) => b.privateBytesDelta - a.privateBytesDelta).slice(0, top),
    warnings: [...new Set(warnings)],
    limitations: ['Process counters do not identify function or allocation-stack hotspots.', 'CLR counters apply to .NET Framework and update at GC boundaries. Gen2 collections include lower-generation collection counts.', 'Private bytes, working set, allocated bytes and retained managed heap are different measurements.'] };
}

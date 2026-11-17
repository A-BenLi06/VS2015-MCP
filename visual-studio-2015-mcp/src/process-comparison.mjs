const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value) && value >= 0;
const positive = value => Number.isFinite(value) && value > 0;
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Each side: {run, summary, collector, settings, evidenceVerified, action?}.
 * collector is a versioned sampler ID; settings are collection settings, not
 * duration/revision/PID. An action is {label,toolName,startUtc,endUtc,success}.
 * The caller verifies the source SHA and regenerates the selected summary.
 */
export function compareProcessSummaries(baseline, candidate, { groups = ['cpu', 'memory'] } = {}) {
  if (!Array.isArray(groups) || !groups.length || groups.some(group => !['cpu', 'memory', 'clr'].includes(group))) {
    throw new Error('groups must select cpu, memory and/or clr.');
  }
  const selected = [...new Set(groups)], reasons = [];
  for (const [label, side] of [['baseline', baseline], ['candidate', candidate]]) {
    if (!object(side?.run) || typeof side.run.operation !== 'string' || !side.run.operation.trim() || !object(side.run.context)) {
      reasons.push(`${label}: operation/context metadata is missing.`);
    }
    if (typeof side?.collector !== 'string' || !side.collector.trim() || !object(side?.settings)) {
      reasons.push(`${label}: versioned collector and collection settings are required.`);
    }
    if (side?.evidenceVerified !== true) reasons.push(`${label}: the source snapshot has not been verified.`);
    if (side?.summary?.complete !== true || side?.summary?.captureFinished !== true) reasons.push(`${label}: the capture is incomplete or invalid.`);
    const window = side?.summary?.requestedWindow ?? {};
    if (side?.action) {
      const action = side.action;
      if (typeof action.label !== 'string' || !action.label.trim() || typeof action.toolName !== 'string' || !action.toolName.trim() || action.success !== true) {
        reasons.push(`${label}: a completed successful action with label/toolName is required.`);
      }
      const start = Date.parse(action.startUtc), end = Date.parse(action.endUtc);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
          Date.parse(window.startUtc) !== start || Date.parse(window.endUtc) !== end) {
        reasons.push(`${label}: the summary window does not match the action span.`);
      }
    } else if (window.startUtc != null || window.endUtc != null) reasons.push(`${label}: a windowed summary requires recorded action identity.`);
  }
  if (baseline?.run?.operation !== candidate?.run?.operation) reasons.push('operation differs.');
  if (!same(baseline?.run?.context, candidate?.run?.context)) reasons.push('context differs.');
  if (baseline?.collector !== candidate?.collector) reasons.push('collector/version differs.');
  if (!same(baseline?.settings, candidate?.settings)) reasons.push('collection settings differ.');
  if (Boolean(baseline?.action) !== Boolean(candidate?.action)) reasons.push('capture scope differs (whole capture versus action).');
  if (baseline?.action && candidate?.action) {
    for (const field of ['label', 'toolName']) if (baseline.action[field] !== candidate.action[field]) reasons.push(`action ${field} differs.`);
  }
  for (const [label, side] of [['baseline', baseline], ['candidate', candidate]]) {
    const summary = side?.summary;
    if (selected.includes('cpu') && (!positive(summary?.measuredIntervalMs) || !finite(summary?.cpuMs) ||
        !Number.isInteger(summary?.intervalCount) || summary.intervalCount < 1 ||
        !Number.isInteger(summary?.logicalProcessors) || summary.logicalProcessors < 1)) {
      reasons.push(`${label}: no valid CPU exposure/counters.`);
    }
    if (selected.includes('memory') && (!Number.isInteger(summary?.memorySampleCount) || summary.memorySampleCount < 1 ||
        !finite(summary?.peakPrivateBytes) || !finite(summary?.peakWorkingSetBytes))) {
      reasons.push(`${label}: no valid memory observations.`);
    }
    if (selected.includes('clr')) {
      const clr = summary?.clr;
      if (clr?.complete !== true || !Number.isInteger(clr.observedIntervals) || clr.observedIntervals < 1 || !positive(clr.measuredIntervalMs) ||
          !['allocatedBytes', 'gen0Collections', 'gen1Collections', 'gen2Collections'].every(key => finite(clr?.[key]))) {
        reasons.push(`${label}: CLR counters/coverage are unavailable, interrupted or incomplete.`);
      }
    }
  }
  if (selected.includes('cpu') && baseline?.summary?.logicalProcessors !== candidate?.summary?.logicalProcessors) reasons.push('logical processor count differs.');
  if (reasons.length) return { comparable: false, reasons: [...new Set(reasons)], groups: selected, rows: [] };

  const a = baseline.summary, b = candidate.summary, rows = [], warnings = [];
  const add = (metric, unit, before, after) => rows.push({ metric, unit, baseline: before, candidate: after,
    delta: after - before, percentChange: before > 0 ? (after - before) / before * 100 : null });
  if (selected.includes('cpu')) {
    add('cpuOneCorePercent', '% of one logical processor', a.cpuMs / a.measuredIntervalMs * 100, b.cpuMs / b.measuredIntervalMs * 100);
    add('cpuMachinePercent', '% of reported processor capacity', a.cpuMs / a.measuredIntervalMs / a.logicalProcessors * 100, b.cpuMs / b.measuredIntervalMs / b.logicalProcessors * 100);
  }
  if (selected.includes('memory')) {
    add('peakPrivateBytes', 'bytes', a.peakPrivateBytes, b.peakPrivateBytes);
    add('peakWorkingSetBytes', 'bytes', a.peakWorkingSetBytes, b.peakWorkingSetBytes);
    if (a.memorySampleCount !== b.memorySampleCount || a.measuredIntervalMs !== b.measuredIntervalMs) {
      warnings.push('Observed memory peaks use different sample counts or capture exposure; peaks are not divided by time and are not exact continuous maxima.');
    }
  }
  if (selected.includes('clr')) {
    add('allocatedBytesPerSecond', 'bytes/second', a.clr.allocatedBytes / a.clr.measuredIntervalMs * 1000, b.clr.allocatedBytes / b.clr.measuredIntervalMs * 1000);
    for (const generation of [0, 1, 2]) {
      const key = `gen${generation}Collections`;
      add(`${key}PerSecond`, 'collections/second', a.clr[key] / a.clr.measuredIntervalMs * 1000, b.clr[key] / b.clr.measuredIntervalMs * 1000);
    }
    warnings.push('Generation collection counts overlap; do not add the generation rates together. Allocated bytes measure allocation activity, not retained heap.');
  }
  const exposure = summary => ({ cpuIntervalMs: summary.measuredIntervalMs, memorySampleCount: summary.memorySampleCount,
    clrIntervalMs: summary.clr?.measuredIntervalMs ?? null, clrObservedIntervals: summary.clr?.observedIntervals ?? 0 });
  return { comparable: true, groups: selected, operation: baseline.run.operation, scope: baseline.action ? 'action' : 'capture',
    actionLabel: baseline.action?.label ?? null, collector: baseline.collector, rows,
    exposure: { baseline: exposure(a), candidate: exposure(b) }, warnings };
}

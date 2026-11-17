import { mkdir, writeFile, readFile, readdir, stat, copyFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const stable = value => JSON.stringify(value, Object.keys(value ?? {}).sort());
export const historyRoot = () => path.resolve(process.env.VS2015_MCP_HISTORY || '.vs2015-mcp/runs');
export function runDirectory(id, root = historyRoot()) {
  if (!idPattern.test(id)) throw new Error('Invalid history run ID.');
  return path.join(root, id);
}
export async function createRun({ operation, context = {}, revision = null }, root = historyRoot()) {
  if (!operation?.trim()) throw new Error('A meaningful operation label is required.');
  const id = randomUUID(), directory = runDirectory(id, root);
  await mkdir(root, { recursive: true });
  const staging = path.join(root, `.${id}.pending`);
  await mkdir(staging);
  const run = { schemaVersion: 1, id, operation, context, revision, createdAt: new Date().toISOString() };
  await writeFile(path.join(staging, 'run.json'), JSON.stringify(run, null, 2), { flag: 'wx' });
  await rename(staging, directory);
  return { ...run, directory };
}
async function publishJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.pending`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
  await rename(temporary, filename);
}
export async function readRun(id, root = historyRoot()) {
  return JSON.parse(await readFile(path.join(runDirectory(id, root), 'run.json'), 'utf8'));
}
export async function appendEvent(id, event, root = historyRoot()) {
  await readRun(id, root);
  const record = { ...event, id: randomUUID(), timestampUtc: new Date().toISOString() };
  const directory = path.join(runDirectory(id, root), 'events');
  await mkdir(directory, { recursive: true });
  await publishJson(path.join(directory, `${record.id}.json`), record);
  return record;
}
export async function saveArtifact(id, kind, data, root = historyRoot()) {
  await readRun(id, root);
  const artifactId = randomUUID(), directory = path.join(runDirectory(id, root), 'artifacts');
  await mkdir(directory, { recursive: true });
  const artifact = { schemaVersion: 1, id: artifactId, kind, createdAt: new Date().toISOString(), data };
  const filename = path.join(directory, `${artifactId}.json`);
  await publishJson(filename, artifact);
  await appendEvent(id, { kind: 'artifact', artifactId, artifactKind: kind }, root);
  return { runId: id, artifactId, kind, path: filename };
}
export async function readArtifact(id, artifactId, root = historyRoot()) {
  if (!idPattern.test(artifactId)) throw new Error('Invalid artifact ID.');
  return JSON.parse(await readFile(path.join(runDirectory(id, root), 'artifacts', `${artifactId}.json`), 'utf8'));
}
export async function snapshotFile(id, filename, root = historyRoot()) {
  const directory = path.join(runDirectory(id, root), 'sources');
  await readRun(id, root);
  if ((await stat(filename)).size > 64 * 1024 * 1024) throw new Error('Report exceeds the 64 MiB import limit.');
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${randomUUID()}${path.extname(filename)}`);
  await copyFile(filename, destination);
  const bytes = await readFile(destination);
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Copied report exceeds the 64 MiB import limit.');
  return { path: destination, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
export async function listRuns({ operation, limit = 30 } = {}, root = historyRoot()) {
  const directories = await readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  const runs = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !idPattern.test(directory.name)) continue;
    const run = await readRun(directory.name, root);
    if (!operation || run.operation === operation) runs.push(run);
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
export async function timeline(id, root = historyRoot()) {
  const run = await readRun(id, root), directory = path.join(runDirectory(id, root), 'events');
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const events = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  return { run, events: events.sort((a, b) => a.timestampUtc.localeCompare(b.timestampUtc)) };
}

// RFC-style quoted fields; delimiter and header position are explicit for localized exports.
export function parseCsv(text, delimiter = ',') {
  text = text.replace(/^\uFEFF/, '');
  if (delimiter.length !== 1 || /[\r\n"]/.test(delimiter)) throw new Error('Invalid CSV delimiter.');
  const rows = []; let row = [], field = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === '"' && field.length === 0 && !afterQuote) quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; afterQuote = false; }
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); if (row.some(value => value.length)) rows.push(row);
      row = []; field = ''; afterQuote = false;
    } else {
      if (afterQuote || char === '"') throw new Error('Malformed CSV quoting.');
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated CSV field.');
  if (field.length || row.length || afterQuote) { row.push(field); rows.push(row); }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  return rows;
}
export async function csvRows(filename, { delimiter = ',', encoding = 'utf-8' } = {}) {
  if ((await stat(filename)).size > 64 * 1024 * 1024) throw new Error('Report exceeds the 64 MiB import limit.');
  const bytes = await readFile(filename);
  return parseCsv(new TextDecoder(encoding, { fatal: true }).decode(bytes), delimiter);
}
export function importHotspots(rows, options) {
  const { headerRow = 0, symbolColumn, valueColumn, moduleColumn, decimalSeparator = '.', thousandsSeparator = '', ...metadata } = options;
  const header = rows[headerRow];
  if (!header) throw new Error('CSV header row does not exist.');
  const column = name => {
    const matches = header.flatMap((value, index) => value === name ? [index] : []);
    if (matches.length !== 1) throw new Error(`CSV column must match exactly once: ${name}`);
    return matches[0];
  };
  if (decimalSeparator === thousandsSeparator) throw new Error('Decimal and thousands separators must differ.');
  const symbolIndex = column(symbolColumn), valueIndex = column(valueColumn), moduleIndex = moduleColumn ? column(moduleColumn) : null;
  const hotspots = [];
  for (const [index, row] of rows.slice(headerRow + 1).entries()) {
    if (row.length !== header.length) throw new Error(`CSV row ${headerRow + index + 2} has the wrong field count.`);
    let number = row[valueIndex].trim();
    if (thousandsSeparator) number = number.split(thousandsSeparator).join('');
    if (decimalSeparator !== '.') number = number.replace(decimalSeparator, '.');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(number)) throw new Error(`Invalid numeric value in CSV row ${headerRow + index + 2}.`);
    const value = Number(number);
    if (!Number.isFinite(value) || value < 0 || !row[symbolIndex].trim()) throw new Error('Hotspot symbols must be nonempty and values nonnegative.');
    hotspots.push({ symbol: row[symbolIndex], module: moduleIndex == null ? '' : row[moduleIndex], value });
  }
  if (!hotspots.length) throw new Error('The report contains no hotspot rows.');
  return { ...metadata, columns: { symbolColumn, valueColumn, moduleColumn }, hotspots };
}
export function compareHotspots(baselineRun, candidateRun, baseline, candidate, { normalization = 'perSecond', limit = 50 } = {}) {
  const mismatches = [];
  if (baselineRun.operation !== candidateRun.operation) mismatches.push('operation');
  if (stable(baselineRun.context) !== stable(candidateRun.context)) mismatches.push('context');
  for (const key of ['metric', 'unit', 'valueSemantics', 'attribution', 'collector', 'scope']) if (baseline[key] !== candidate[key]) mismatches.push(key);
  if (!baseline.valueSemantics || !candidate.valueSemantics) mismatches.push('missing valueSemantics; re-import the source report');
  if (stable(baseline.settings ?? {}) !== stable(candidate.settings ?? {})) mismatches.push('collection settings');
  if (mismatches.length) return { comparable: false, mismatches, rows: [] };
  if (baseline.valueSemantics !== 'total' && !['total', 'none'].includes(normalization)) {
    throw new Error('Rates, ratios and gauges must use normalization=none; only accumulated totals can be normalized by exposure.');
  }
  const divisor = report => {
    if (normalization === 'total' || normalization === 'none') return 1;
    const value = normalization === 'perOperation' ? report.workUnits : report.durationMs / 1000;
    if (!(value > 0) || !Number.isFinite(value)) throw new Error(`Positive ${normalization === 'perOperation' ? 'workUnits' : 'durationMs'} is required.`);
    return value;
  };
  const aggregate = report => {
    const map = new Map();
    for (const row of report.hotspots) {
      const key = JSON.stringify([row.module, row.symbol]);
      if (report.valueSemantics !== 'total' && map.has(key)) {
        throw new Error('Duplicate module/symbol keys in a non-total report require explicit aggregation semantics; refusing to sum rates, ratios or gauges.');
      }
      const previous = map.get(key) ?? { ...row, value: 0 };
      previous.value += row.value / divisor(report); map.set(key, previous);
    }
    return map;
  };
  const left = aggregate(baseline), right = aggregate(candidate), rows = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key), b = right.get(key);
    const before = a?.value ?? (baseline.complete ? 0 : null), after = b?.value ?? (candidate.complete ? 0 : null);
    rows.push({ symbol: (a ?? b).symbol, module: (a ?? b).module, baseline: before, candidate: after,
      delta: before == null || after == null ? null : after - before,
      percentChange: before > 0 && after != null ? (after - before) / before * 100 : null,
      status: before == null || after == null ? 'unknown-missing-row' : !a ? 'added' : !b ? 'removed' : 'matched' });
  }
  rows.sort((a, b) => (b.delta == null ? -1 : Math.abs(b.delta)) - (a.delta == null ? -1 : Math.abs(a.delta)));
  return { comparable: true, normalization, metric: baseline.metric, unit: baseline.unit, attribution: baseline.attribution,
    totalSymbols: rows.length, rows: rows.slice(0, limit),
    warnings: [baseline.complete && candidate.complete ? null : 'Incomplete reports: missing rows are unknown, not zero.',
      baseline.attribution === 'inclusive' ? 'Inclusive values overlap across callers; do not sum them.' : null,
      normalization === 'total' && baseline.durationMs !== candidate.durationMs ? 'Capture durations differ; raw totals are not exposure-normalized.' : null].filter(Boolean) };
}

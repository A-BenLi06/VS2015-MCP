import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDiagnostics } from '../src/diagnostics.mjs';

const events = [
  { schemaVersion: 1, sequence: 1, kind: 'sessionStarted' },
  { schemaVersion: 1, sequence: 2, kind: 'warning', code: 'W123', message: '中文 "warning"', line: 24, column: 3 },
  { schemaVersion: 1, sequence: 3, kind: 'sessionFinished', eventsWritten: 3, buildFinishedObserved: true, diagnosticsComplete: true, succeeded: true, errorCount: 0, warningCount: 1 },
];
test('diagnostics retain structured positions and original language', () => {
  const result = summarizeDiagnostics(events);
  assert.equal(result.complete, true); assert.equal(result.warningCount, 1);
  assert.equal(result.diagnostics[0].line, 24); assert.match(result.diagnostics[0].message, /中文/);
});
test('interrupted or invalid logs never report authoritative zero errors', () => {
  assert.equal(summarizeDiagnostics(events.slice(0, 2)).errorCount, null);
  assert.equal(summarizeDiagnostics(events, ['broken JSON']).complete, false);
  const dropped = [...events.slice(0, 2), { ...events[2], diagnosticsComplete: false, droppedDiagnostics: 5, errorCount: 5 }];
  assert.equal(summarizeDiagnostics(dropped).errorCount, 5);
  assert.equal(summarizeDiagnostics(dropped).complete, false);
});

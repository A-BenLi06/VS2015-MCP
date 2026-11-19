import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { profilerDefinitions } from '../src/profiler.mjs';

test('eventsXml schema does not require a guessed process name', () => {
  const schema = profilerDefinitions.find(t => t.name === 'vs2015_perfview_report').schema;
  assert.equal(schema.parse({ analysis: 'eventsXml', inputPath: 'guest.etl' }).dryRun, true);
});
test('streamed trace summary preserves raw identities and rejects incomplete XML and DTD', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-summary-')); t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'test.ps1');
  await writeFile(script, `param([string]$Module,[string]$Root)
$ErrorActionPreference='Stop'
Import-Module $Module
$xml=Join-Path $Root 'events.xml'
@'
<Events><Event EventName="EventTrace" EventsLost="1,234" BuffersLost="0"/><Event EventName="Process/Start" PID="4" MSec="1" UniqueProcessKey="0xA"/><Event EventName="PerfInfo/Sample" PID="4" PName="应用"/><Event EventName="Process/Stop" PID="4" MSec="2" UniqueProcessKey="0xA"/><Event EventName="Process/Start" PID="4" MSec="3" UniqueProcessKey="0xB"/><Event EventName="PerfInfo/Sample" PID="4" PName="应用"/><Event EventName="Other"><Event EventName="Nested"/></Event><Event MSec="4" TaskName="Task(provider-guid)" OpcodeNum="53"/></Events>
'@ | Set-Content $xml -Encoding utf8
$summary=Read-TraceEventSummary $xml
$limited=Read-TraceEventSummary $xml -MaxGroups 1 -MaxProcessObservations 1
$failures=0
foreach($bad in @('<Events><Event EventName="PerfInfo/Sample"/>','<!DOCTYPE Events [<!ENTITY x SYSTEM "file:///missing">]><Events>&x;</Events>','<Events><Event/></Events>','<Wrong/>')) {
  $bad|Set-Content $xml -Encoding utf8
  try{$null=Read-TraceEventSummary $xml}catch{$failures++}
}
@{summary=$summary;limited=$limited;rejected=$failures}|ConvertTo-Json -Depth 12 -Compress
`);
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Module', fileURLToPath(new URL('../scripts/TraceEventSummary.psm1', import.meta.url)), '-Root', root], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
  assert.equal(data.summary.eventCount, 8); assert.equal(data.summary.cpuSampleEvents, 2); assert.equal(data.summary.unresolvedEventCount, 1);
  assert.equal(data.summary.processObservations.length, 3); assert.equal(data.summary.traceHeaders[0].EventsLost, '1,234');
  assert.equal(data.summary.applicationAttributionVerified, false); assert.equal(data.summary.samplesByObservedPidAndName[0].sampleEvents, 2);
  assert.equal(data.limited.summaryTruncated, true); assert.equal(data.rejected, 4);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSamples } from '../src/samples.mjs';
import { compareProcessSummaries } from '../src/process-comparison.mjs';

const sample = (time, clrTime, cpu, alloc) => ({ kind:'sample', timestampUtc:new Date(time).toISOString(), elapsedMs:time,
  cpuTotalMs:cpu, privateBytes:1000-time/10, workingSetBytes:500,
  clr:{instance:'test',timestampUtc:new Date(clrTime).toISOString(),allocatedBytesCounter:alloc,gen0Collections:time/1000,gen1Collections:0,gen2Collections:0} });
const trace = (samples) => [{kind:'start',schemaVersion:1,logicalProcessors:4},...samples,{kind:'end',samples:samples.length,complete:true}];
test('CLR interval survives a CPU interval crossing the action left boundary', () => {
  const result = summarizeSamples(trace([sample(0,500,0,0),sample(1000,1500,100,100)]), {startUtc:new Date(500).toISOString(),endUtc:new Date(1600).toISOString()});
  assert.equal(result.intervalCount,0);assert.equal(result.cpuOneCorePercent,null);
  assert.equal(result.clr.measuredIntervalMs,1000);assert.equal(result.clr.allocatedBytes,100);assert.equal(result.clr.complete,true);
});
test('CLR right-boundary exclusion and CPU interval compatibility remain intact', () => {
  const events=trace([sample(0,500,0,0),sample(1000,2000,100,100)]);
  const partial=summarizeSamples(events,{startUtc:new Date(0).toISOString(),endUtc:new Date(1500).toISOString()});
  assert.equal(partial.intervalCount,1);assert.equal(partial.clr,null);assert.equal(partial.cpuHotIntervals[0].clr,null);
  const whole=summarizeSamples(events);
  assert.equal(whole.clr.measuredIntervalMs,1500);assert.equal(whole.cpuHotIntervals[0].clr.allocatedBytes,100);
  assert.equal(whole.peakPrivateBytes,1000);assert.equal(whole.memorySampleCount,2);
});
test('missing CLR pairs remain explicit and cannot look like full CLR coverage', () => {
  const values=[sample(0,0,0,0),sample(1000,1000,100,100),sample(2000,2000,200,200)];values[0].clr=null;
  const result=summarizeSamples(trace(values));
  assert.equal(result.complete,true);assert.equal(result.clr.complete,false);assert.equal(result.clrCoverage.missingIntervals,1);
  assert.equal(result.clr.allocatedBytes,100);
});
test('counter resets reject CLR comparisons while preserving valid CPU data', () => {
  const values=[sample(0,0,0,100),sample(1000,1000,100,0),sample(2000,2000,200,100)];
  const result=summarizeSamples(trace(values));
  assert.equal(result.complete,true);assert.equal(result.clr.complete,false);assert.equal(result.clrCoverage.rejectedIntervals,1);
});

const summary = ({cpuMs=100,elapsed=1000,clrElapsed=2000,allocated=1000,gen0=2,peak=1000}={}) => ({
  complete:true,captureFinished:true,requestedWindow:{},sampleCount:3,intervalCount:2,memorySampleCount:3,logicalProcessors:4,
  measuredIntervalMs:elapsed,cpuMs,peakPrivateBytes:peak,peakWorkingSetBytes:500,
  clr:{complete:true,observedIntervals:2,measuredIntervalMs:clrElapsed,allocatedBytes:allocated,gen0Collections:gen0,gen1Collections:0,gen2Collections:0}
});
const side = value => ({run:{operation:'load',context:{target:'fixture',configuration:'Debug'},revision:'a'},summary:value,
  collector:'vs2015-process-counters/1',settings:{intervalMs:500,includeClr:true},evidenceVerified:true});
test('CPU and CLR use separate exposure; peaks remain absolute', () => {
  const a=side(summary()), b=side(summary({cpuMs:400,elapsed:2000,clrElapsed:1000,allocated:1000,gen0:4,peak:800}));
  b.run.revision='b';
  const result=compareProcessSummaries(a,b,{groups:['cpu','memory','clr']});assert.equal(result.comparable,true);
  const row=name=>result.rows.find(r=>r.metric===name);
  assert.equal(row('cpuOneCorePercent').baseline,10);assert.equal(row('cpuOneCorePercent').candidate,20);
  assert.equal(row('allocatedBytesPerSecond').baseline,500);assert.equal(row('allocatedBytesPerSecond').candidate,1000);
  assert.equal(row('gen0CollectionsPerSecond').baseline,1);assert.equal(row('gen0CollectionsPerSecond').candidate,4);
  assert.equal(row('peakPrivateBytes').candidate,800);assert.equal(row('peakPrivateBytes').percentChange,-20);
  assert.equal(row('gen2CollectionsPerSecond').percentChange,null);
});
test('identity/settings mismatch, unverifiable sources and incomplete data are rejected', () => {
  const baseline=side(summary());
  for(const mutate of [s=>s.run.operation='different',s=>s.run.context.target='other',s=>s.collector='v2',s=>s.settings.intervalMs=1000,
    s=>s.evidenceVerified=false,s=>s.summary.complete=false,s=>s.summary.cpuMs=NaN]) {
    const candidate=structuredClone(baseline);mutate(candidate);assert.equal(compareProcessSummaries(baseline,candidate).comparable,false);
  }
  const candidate=structuredClone(baseline);candidate.summary.clr.complete=false;
  assert.equal(compareProcessSummaries(baseline,candidate).comparable,true);
  assert.equal(compareProcessSummaries(baseline,candidate,{groups:['clr']}).comparable,false);
});
test('actions require identical labels and summaries of their actual spans', () => {
  const baseline=side(summary()),candidate=side(summary());
  for(const input of [baseline,candidate]) {
    input.action={label:'Open list',toolName:'phone_tap',success:true,startUtc:new Date(0).toISOString(),endUtc:new Date(2000).toISOString()};
    input.summary.requestedWindow={startUtc:input.action.startUtc,endUtc:input.action.endUtc};
  }
  assert.equal(compareProcessSummaries(baseline,candidate).comparable,true);
  candidate.action.label='Scroll list';assert.equal(compareProcessSummaries(baseline,candidate).comparable,false);
  candidate.action.label='Open list';candidate.summary.requestedWindow.endUtc=new Date(1000).toISOString();
  assert.equal(compareProcessSummaries(baseline,candidate).comparable,false);
});

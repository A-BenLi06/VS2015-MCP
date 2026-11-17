import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { profilerDefinitions } from '../../src/profiler.mjs';

test('archive extraction selects one bounded member without trusting its path', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs2015-archive-'));
  const previous = process.env.VS2015_MCP_HISTORY; process.env.VS2015_MCP_HISTORY = path.join(directory, 'history');
  const inputPath = path.join(directory, 'fixture.vspx'), maker = path.join(directory, 'make.ps1');
  await writeFile(maker, `param([string]$ArchivePath)
$file=[IO.File]::Create($ArchivePath)
$zip=[IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Create)
try { foreach($name in @('../../escape.etl','nested/second.etl')) {
  $stream=$zip.CreateEntry($name).Open()
  try {$bytes=[Text.Encoding]::UTF8.GetBytes('container-test only, not real ETL');$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
} }finally{$zip.Dispose();$file.Dispose()}
`);
  const tool = profilerDefinitions.find(item => item.name === 'vs2015_trace_extract');
  const call = args => tool.run(tool.schema.parse({ inputPath, ...args }), {});
  try {
    await promisify(execFile)(process.env.VS2015_MCP_PWSH || 'pwsh.exe', ['-NoProfile', '-File', maker, inputPath], { windowsHide: true });
    const multiple = await call({}); assert.match(multiple.error.message, /Multiple ETL/); assert.equal(multiple.etlEntries.length, 2);
    const large = await call({ entryName: '../../escape.etl', maxBytes: 1 }); assert.match(large.error.message, /exceeds maxBytes/);
    const extracted = await call({ entryName: '../../escape.etl', dryRun: false });
    assert.equal(extracted.error, undefined); assert.equal(extracted.traceValidated, false); assert.equal(extracted.executed, true);
    assert.ok(path.relative(path.join(directory, 'history'), extracted.path).split(path.sep).every(part => part !== '..'));
    assert.equal(await readFile(extracted.path, 'utf8'), 'container-test only, not real ETL');
    assert.ok(extracted.artifactId);
  } finally { if (previous === undefined) delete process.env.VS2015_MCP_HISTORY; else process.env.VS2015_MCP_HISTORY = previous; }
});

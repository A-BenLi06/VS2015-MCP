import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, appendFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const enabled = process.platform === 'win32' && process.env.VS2015_TEST_IDE_CACHE === '1';
test('IDE compiler cache serializes writers, invalidates changed sources and rejects corruption', { skip: !enabled, timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v15-cache-'));
  const scripts = path.join(root, 'scripts'), sources = path.join(root, 'ide-bridge'), cacheRoot = path.join(root, 'cache');
  await mkdir(scripts); await mkdir(sources);
  const script = path.join(scripts, 'Build-IdeBridge.ps1');
  await copyFile(fileURLToPath(new URL('../../scripts/Build-IdeBridge.ps1', import.meta.url)), script);
  const sourceRoot = fileURLToPath(new URL('../../ide-bridge/', import.meta.url));
  const names = (await readdir(sourceRoot)).filter(name => name.endsWith('.cs'));
  for (const name of names) await copyFile(path.join(sourceRoot, name), path.join(sources, name));
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.env.VS2015_MCP_PWSH || 'pwsh.exe', ['-NoProfile', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => { try { resolve({ code, result: JSON.parse(stdout.replace(/^\uFEFF/, '')), stderr }); } catch (error) { reject(new Error(`${error.message}: ${stdout} ${stderr}`)); } });
    child.stdin.end(JSON.stringify({ cacheRoot }));
  });
  const [first, concurrent] = await Promise.all([invoke(), invoke()]);
  assert.equal(first.code, 0, JSON.stringify(first)); assert.equal(concurrent.code, 0, JSON.stringify(concurrent));
  assert.equal(first.result.cacheKey, concurrent.result.cacheKey);
  assert.deepEqual([first.result.cacheHit, concurrent.result.cacheHit].sort(), [false, true]);
  const warm = await invoke(); assert.equal(warm.result.cacheHit, true); assert.equal(warm.result.executablePath, first.result.executablePath);
  const manifest = JSON.parse(await readFile(warm.result.manifestPath, 'utf8'));
  assert.ok(manifest.inputs.sources.length === names.length); assert.ok(manifest.inputs.references.some(item => item.name === 'EnvDTE90a.dll'));
  const artifactNames = manifest.artifacts.map(item => item.name);
  assert.ok(artifactNames.includes('Vs2015.IdeBridge.exe')); assert.equal(new Set(artifactNames).size, artifactNames.length);
  await appendFile(path.join(sources, names[0]), '\n// Compilation cache invalidation regression\n');
  const changed = await invoke(); assert.equal(changed.code, 0, JSON.stringify(changed)); assert.equal(changed.result.cacheHit, false);
  assert.notEqual(changed.result.cacheKey, warm.result.cacheKey); assert.notEqual(changed.result.executablePath, warm.result.executablePath);
  await appendFile(changed.result.executablePath, Buffer.from([0]));
  const corrupted = await invoke(); assert.equal(corrupted.code, 1); assert.equal(corrupted.result.error.code, 'IDE_CACHE_INTEGRITY_FAILED');
  assert.match(corrupted.result.error.message, /artifact changed/);
  // Failed cache reuse must not modify or silently replace the altered bytes.
  const before = await readFile(changed.result.executablePath); const again = await invoke();
  assert.equal(again.result.error.code, 'IDE_CACHE_INTEGRITY_FAILED');
  assert.deepEqual(await readFile(changed.result.executablePath), before);
});

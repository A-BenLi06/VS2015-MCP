import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { IdeBridgeClient } from '../../src/ide-client.mjs';

const product = process.env.VS2015_TEST_PRODUCT_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = process.env.VS2015_TEST_APP_IDENTITY_MANIFEST;
async function run(executable, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned app-identity test helper timed out.')); }, 90000);
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code ? reject(new Error(`App-identity helper failed (${code}): ${stdout} ${stderr}`)) : resolve(stdout); });
    child.stdin.end(input);
  });
}

test('project app identity parser preserves schema-qualified fields and rejects unsafe XML', { skip: process.platform !== 'win32' || !manifestPath, timeout: 180000 }, async () => {
  const built = JSON.parse(await run(process.env.VS2015_MCP_PWSH ?? 'pwsh.exe', ['-NoProfile', '-File', path.join(product, 'scripts/Build-IdeBridge.ps1')], '{}'));
  assert.ok(built.executablePath, built.error?.message);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'v15-app-identity-parser-'));
  const executable = path.join(scratch, 'AppIdentityParserTests.exe');
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework/v4.0.30319/csc.exe');
  await run(compiler, ['/nologo', '/utf8output', '/platform:x86', '/reference:System.Web.Extensions.dll', `/out:${executable}`, path.join(product, 'test/fixtures/AppIdentityParserTests.cs')]);
  const result = JSON.parse(await run(executable, [built.executablePath]));
  assert.equal(result.passed, true); assert.equal(result.checks, 16);
});

test('actual included project manifest identity rejects unsaved IDE buffer state', { skip: process.platform !== 'win32' || !manifestPath, timeout: 180000 }, async () => {
  const relative = path.relative(os.tmpdir(), path.resolve(manifestPath));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const fixture = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(fixture.ownsIde, true);
  assert.ok(path.isAbsolute(fixture.manifestPath));
  const manifestRelative = path.relative(os.tmpdir(), fixture.manifestPath);
  assert.ok(manifestRelative && !manifestRelative.startsWith('..') && !path.isAbsolute(manifestRelative));
  const built = JSON.parse(await run(process.env.VS2015_MCP_PWSH ?? 'pwsh.exe', ['-NoProfile', '-File', path.join(product, 'scripts/Build-IdeBridge.ps1')], '{}'));
  assert.ok(built.executablePath, built.error?.message);
  const client = new IdeBridgeClient({ launch: () => spawn(built.executablePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) });
  let sessionId, originalText, changed = false;
  const call = async (operation, input = {}) => {
    try { return await client.request(operation, { sessionId, ...input }, { timeoutMs: 30000 }); }
    catch (error) { error.message = `${operation}: ${error.message}`; throw error; }
  };
  try {
    sessionId = (await call('attach', { processId: fixture.processId, expectedStartTimeUtc: fixture.startTimeUtc })).sessionId;
    const request = { projectUniqueName: fixture.projectUniqueName, manifestPath: fixture.manifestPath };
    const identity = await call('projectAppIdentity', request);
    assert.equal(identity.projectUniqueName.toLowerCase(), fixture.projectUniqueName.toLowerCase());
    assert.equal(identity.manifestPath.toLowerCase(), fixture.manifestPath.toLowerCase());
    assert.match(identity.manifestSha256, /^[a-f0-9]{64}$/);
    assert.ok(identity.packageIdentity.name && identity.packageIdentity.publisher && identity.packageIdentity.version);
    assert.ok(identity.applications.length > 0);
    if (fixture.phoneProductId) assert.equal(identity.phoneIdentity.phoneProductId.toLowerCase(), fixture.phoneProductId.toLowerCase());
    await assert.rejects(call('projectAppIdentity', { ...request, manifestPath: path.join(os.tmpdir(), 'not-included.appxmanifest') }), { code: 'APP_MANIFEST_NOT_INCLUDED' });
    const opened = await call('openDocument', { path: fixture.manifestPath, view: 'code', replaceSavedView: true });
    assert.equal(opened.textBufferAvailable, true);
    const before = await call('readDocument', { path: fixture.manifestPath, maxChars: 1000000 });
    assert.equal(before.saved, true); assert.equal(before.truncated, false); originalText = before.text;
    const edited = originalText + '\n<!-- owned identity regression fixture -->\n';
    await call('editDocument', { path: fixture.manifestPath, expectedText: originalText, text: edited, save: false }); changed = true;
    await assert.rejects(call('projectAppIdentity', request), { code: 'APP_MANIFEST_UNSAVED' });
    await assert.rejects(call('openDocument', { path: fixture.manifestPath, view: 'text', replaceSavedView: true }), { code: 'DOCUMENT_UNSAVED_VIEW' });
    await call('editDocument', { path: fixture.manifestPath, expectedText: edited, text: originalText, save: true }); changed = false;
    const restored = await call('projectAppIdentity', request);
    assert.deepEqual(restored.packageIdentity, identity.packageIdentity);
    assert.deepEqual(restored.phoneIdentity, identity.phoneIdentity);
  } finally {
    try {
      if (changed) {
        const current = await call('readDocument', { path: fixture.manifestPath, maxChars: 1000000 });
        await call('editDocument', { path: fixture.manifestPath, expectedText: current.text, text: originalText, save: true });
      }
    } finally {
      if (sessionId) await call('detach').catch(() => {});
      await client.stop();
    }
  }
});

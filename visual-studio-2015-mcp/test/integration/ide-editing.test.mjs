import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('IDE range edits preserve UTF-16 locations and reject stale or overlapping changes', {
  skip: process.platform !== 'win32' || !process.env.VS2015_TEST_IDE_MANIFEST, timeout: 120000,
}, async () => {
  const manifest = path.resolve(process.env.VS2015_TEST_IDE_MANIFEST);
  const relative = path.relative(os.tmpdir(), manifest); assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
  const fixture = JSON.parse(await readFile(manifest, 'utf8'));
  const filename = path.join(path.dirname(manifest), 'editor-validation.txt');
  const original = 'Alpha\t中文🙂\r\nSecond\r\n'; await writeFile(filename, original);
  const client = new Client({ name: 'ide-edit-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: process.env }));
  const raw = (name, args) => client.callTool({ name, arguments: args }, { timeout: 90000 });
  const call = async (name, args) => { const result = await raw(name, args); assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent; };
  let sessionId;
  try {
    ({ sessionId } = await call('vs2015_attach', { processId: fixture.processId, expectedStartTimeUtc: fixture.startTimeUtc }));
    await call('vs2015_document_open', { sessionId, path: filename });
    const before = await call('vs2015_document_read', { sessionId, path: filename }); assert.equal(before.text, original);
    assert.equal(before.sha256, createHash('sha256').update(original).digest('hex'));
    const edits = [
      { start: { line: 1, column: 7 }, end: { line: 1, column: 9 }, expectedText: '中文', text: '汉字' },
      { start: { line: 1, column: 9 }, end: { line: 1, column: 11 }, expectedText: '🙂', text: '🚆' },
      { start: { line: 2, column: 1 }, end: { line: 2, column: 7 }, expectedText: 'Second', text: 'Changed' },
    ];
    const edited = await call('vs2015_document_edit', { sessionId, path: filename, expectedSha256: before.sha256, edits });
    assert.equal(edited.saved, false); assert.equal(edited.editCount, 3);
    const current = await call('vs2015_document_read', { sessionId, path: filename });
    assert.equal(current.text, 'Alpha\t汉字🚆\r\nChanged\r\n');
    assert.equal(current.sha256, edited.sha256);
    const stale = await raw('vs2015_document_edit', { sessionId, path: filename, expectedSha256: before.sha256, edits });
    assert.equal(stale.structuredContent.error.code, 'DOCUMENT_CONFLICT');
    const overlap = await raw('vs2015_document_edit', { sessionId, path: filename, expectedSha256: current.sha256, edits: [
      { start: { line: 1, column: 1 }, end: { line: 1, column: 4 }, text: 'a' },
      { start: { line: 1, column: 2 }, end: { line: 1, column: 3 }, text: 'b' },
    ] });
    assert.equal(overlap.structuredContent.error.code, 'EDIT_RANGES_OVERLAP');
    const invalid = await raw('vs2015_document_edit', { sessionId, path: filename, expectedSha256: current.sha256,
      edits: [{ start: { line: 1, column: 1 }, end: { line: 200, column: 1 }, text: 'bad' }] });
    assert.equal(invalid.structuredContent.error.code, 'EDIT_RANGE_INVALID');
    assert.equal((await call('vs2015_document_read', { sessionId, path: filename })).text, current.text);
    assert.equal(await readFile(filename, 'utf8'), original, 'Unsaved edits must not silently write disk');
  } finally {
    if (sessionId) {
      const current = await call('vs2015_document_read', { sessionId, path: filename }).catch(() => null);
      if (current) await call('vs2015_document_replace', { sessionId, path: filename, expectedText: current.text, text: original, save: true }).catch(() => {});
      await call('vs2015_detach', { sessionId }).catch(() => {});
    }
    await client.close();
  }
});

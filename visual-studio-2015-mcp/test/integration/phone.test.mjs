import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('phone MCP discovery, deployment plans and optional read-only capture', { skip: process.platform !== 'win32', timeout: 300000 }, async t => {
  const client = new Client({ name: 'phone-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phone-mcp-'));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 180000, signal: t.signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result;
  };
  try {
    await client.connect(transport);
    const result = await call('phone_discover');
    assert.ok(Array.isArray(result.structuredContent.xde));
    assert.ok(Array.isArray(result.structuredContent.running));
    await t.test('deployment plan preserves literals and redacts PIN', async () => {
      const planned = await call('phone_deploy', { platform: 'win10m', action: 'install', ip: '192.0.2.1', package: 'a & b.appx', pin: 'test-only-secret', dryRun: true });
      assert.equal(planned.structuredContent.dryRun, true);
      assert.ok(planned.structuredContent.arguments.includes('[redacted]'));
      assert.ok(!JSON.stringify(planned).includes('test-only-secret'));
    });
    const processId = Number(process.env.VS2015_TEST_XDE_PID);
    await t.test('capture from an explicitly selected running emulator', { skip: !processId }, async () => {
      const state = await call('phone_status', { processId });
      assert.ok(state.structuredContent.display.width > 0);
      const filename = path.join(directory, 'guest.png');
      const capture = await call('phone_screenshot', { processId, path: filename });
      assert.ok(capture.content.some(block => block.type === 'image' && block.mimeType === 'image/png'));
      assert.equal((await readFile(filename)).subarray(1, 4).toString(), 'PNG');
    });
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

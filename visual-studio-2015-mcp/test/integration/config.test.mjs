import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

test('generated MCP config selects one executable and only prints settings', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v15-config-'));
  const history = path.join(root, 'history-not-created');
  const { stdout } = await promisify(execFile)(process.env.VS2015_MCP_PWSH || 'pwsh.exe', ['-NoProfile', '-File',
    fileURLToPath(new URL('../../scripts/Print-McpConfig.ps1', import.meta.url)), '-HistoryRoot', history], { windowsHide: true });
  const config = JSON.parse(stdout).mcpServers['visual-studio-2015'];
  assert.equal(typeof config.command, 'string');
  assert.equal(typeof config.env.VS2015_MCP_PWSH, 'string');
  await access(config.command); await access(config.env.VS2015_MCP_PWSH);
  assert.equal(config.env.VS2015_MCP_HISTORY, history);
  await assert.rejects(access(history), { code: 'ENOENT' });
});

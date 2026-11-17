import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('real CDB reads an owned Framework process without ending it', {
  skip: process.platform !== 'win32' || !process.env.VS2015_TEST_CDB_ROOT, timeout: 180000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v15-cdb-'));
  const source = path.join(directory, 'Owned.cs'), executable = path.join(directory, 'Owned.exe'), ready = path.join(directory, 'ready');
  await writeFile(source, 'using System;using System.IO;using System.Threading;class Owned{static byte[][] held=new byte[16][];static void Main(string[] a){for(int i=0;i<held.Length;i++)held[i]=new byte[1048576+i];GC.Collect();File.WriteAllText(a[0],"ready");for(;;)Thread.Sleep(1000);}}');
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await promisify(execFile)(compiler, ['/nologo', '/debug:pdbonly', '/platform:x64', `/out:${executable}`, source], { windowsHide: true });
  const child = spawn(executable, [ready], { windowsHide: true, stdio: 'ignore' });
  const client = new Client({ name: 'debug-runtime', version: '1' });
  try {
    const deadline = Date.now() + 10000;
    while (true) {
      try { await readFile(ready); break; } catch { if (Date.now() > deadline) throw new Error('Fixture did not become ready'); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../../src/server.mjs', import.meta.url))], env: { ...process.env,
        VS2015_MCP_HISTORY: path.join(directory, 'history'), VS2015_MCP_DEBUGGER_ROOT: process.env.VS2015_TEST_CDB_ROOT } }));
    const result = await client.callTool({ name: 'vs2015_debug_snapshot', arguments: {
      processId: child.pid, architecture: 'x64', managedRuntime: 'clr', symbolPath: directory, timeoutMs: 60000,
    } }, { timeout: 90000, signal: t.signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.reportCompletion, 'completed');
    assert.match(result.structuredContent.stdout, /Owned\.Main/);
    assert.equal(child.exitCode, null, 'The owned target must remain running after the snapshot');
    process.kill(child.pid, 0);
    if (process.env.VS2015_TEST_MANAGED_DUMP) {
      const dump = await client.callTool({ name: 'vs2015_debug_dump', arguments: {
        dumpPath: process.env.VS2015_TEST_MANAGED_DUMP, architecture: 'x64', managedRuntime: 'clr', heapSummary: true,
        symbolPath: directory, maxOutputChars: 256000, timeoutMs: 60000,
      } }, { timeout: 90000, signal: t.signal });
      assert.equal(dump.isError, false, JSON.stringify(dump));
      assert.equal(dump.structuredContent.reportCompletion, 'completed');
      assert.match(dump.structuredContent.stdout, /System\.Byte\[\]/);
    }
  } finally {
    await client.close();
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  }
});

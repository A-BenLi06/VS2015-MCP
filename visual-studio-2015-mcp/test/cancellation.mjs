import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const execFileAsync = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'vs2015-cancel-proof-'));
const windowsPs = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const taskkill = path.join(process.env.SystemRoot, 'System32/taskkill.exe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const script = path.join(directory, 'slow-child.mjs');
await writeFile(script, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => {}, 240000);\n");
const report = { directory, results: [] };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const owned = new Set();

async function until(predicate, timeoutMs = 60000) {
 const start = Date.now();
 while (Date.now() - start < timeoutMs) { const result = await predicate(); if (result) return result; await sleep(100); }
 throw new Error(`Condition not reached after ${timeoutMs} ms`);
}
async function pidFrom(file) { try { const n = Number((await readFile(file, 'utf8')).trim()); return Number.isInteger(n) && n > 0 ? n : false; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function chainFor(pid, rootPid) {
 const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
 const { stdout } = await execFileAsync(windowsPs, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, maxBuffer: 4194304 });
 const all = JSON.parse(stdout), chain = [];
 for (let id = pid; id; ) { const p = all.find(p => p.ProcessId === id); assert.ok(p, `Missing PID ${id}`); chain.push(p); if (id === rootPid) break; id = p.ParentProcessId; }
 assert.equal(chain.at(-1)?.ProcessId, rootPid, 'Slow process must descend from this test server');
 chain.forEach(p => owned.add(p.ProcessId));
 assert.ok(chain.some(p => p.Name.toLowerCase() === 'pwsh.exe'), 'PowerShell bridge must appear in process chain');
 assert.ok(chain.some(p => p.Name.toLowerCase() === 'msbuild.exe'), 'MSBuild must appear in process chain');
 return chain;
}
async function fixture(name) {
 const marker = path.join(directory, `${name}.pid`), project = path.join(directory, `${name}.proj`);
 const command = `"${process.execPath}" "${script}" "${marker}"`;
 await writeFile(project, `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003" DefaultTargets="Wait"><Target Name="Wait"><Exec Command="${xml(command)}" /></Target></Project>`);
 return {marker, project};
}
async function waitGone(chain) { await until(() => chain.every(p => !alive(p.ProcessId)), 20000); }

async function cancellation() {
 const {marker, project} = await fixture('cancel');
 const client = new Client({ name: 'vs2015-cancel-review', version: '1.0.0' });
 const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'src/server.mjs')], cwd:repo, env:process.env, stderr:'pipe'});
 let diagnostics = '';
 transport.stderr.on('data', chunk => diagnostics += chunk.toString());
 const abort = new AbortController();
 try {
  await client.connect(transport);
  const serverPid = transport.pid; owned.add(serverPid);
  let outcome;
  const call = client.callTool({name:'vs2015_msbuild', arguments:{path:project, setupTimeoutMs:120000, timeoutMs:240000}}, {signal:abort.signal, timeout:400000})
    .then(value => (outcome = {value}), error => (outcome = {error:String(error)}));
  const leafPid = await until(async () => {
   const pid = await pidFrom(marker);
   if (pid) return pid;
   if (outcome) throw new Error(`Build returned before PID marker: ${JSON.stringify(outcome)}`);
   return false;
  }, 180000);
  console.error('Cancellation marker reached:', leafPid);
  const chain = await chainFor(leafPid, serverPid);
  const start = Date.now(); abort.abort('Cancellation integration test');
  const result = await call;
  assert.ok(result.error, `Expected cancelled request rejection, got ${JSON.stringify(result)}`);
  await waitGone(chain.filter(p => p.ProcessId !== serverPid));
  assert.ok(alive(serverPid), 'Server should remain usable after cancellation');
  const tools = await client.listTools(); assert.ok(tools.tools.length >= 8);
  report.results.push({test:'MCP cancellation', passed:true, elapsedMs:Date.now()-start, chain, result, diagnostics});
 } finally { abort.abort('Test cleanup'); await client.close(); }
}

async function eof() {
 const {marker, project} = await fixture('eof');
 const child = spawn(process.execPath, [path.join(repo, 'src/server.mjs')], {cwd:repo,env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 owned.add(child.pid);
 let output = '', diagnostics = '';
 const messages = [];
 child.stdout.setEncoding('utf8');
 child.stdout.on('data', chunk => {output += chunk; let end; while ((end=output.indexOf('\n'))>=0) {const line=output.slice(0,end);output=output.slice(end+1);if(line.trim())messages.push(JSON.parse(line));}});
 child.stderr.on('data', chunk => diagnostics += chunk.toString());
 const send = value => child.stdin.write(JSON.stringify(value)+'\n');
 try {
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'EOF-review',version:'1.0.0'}}});
  const init = await until(() => messages.find(message=>message.id===1)); assert.ok(init.result,JSON.stringify(init));
  send({jsonrpc:'2.0',method:'notifications/initialized'});
  send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'vs2015_msbuild',arguments:{path:project,setupTimeoutMs:120000,timeoutMs:240000}}});
  const leafPid = await until(async () => {
   const pid = await pidFrom(marker);
   if (pid) return pid;
   const outcome = messages.find(message => message.id === 2);
   if (outcome) throw new Error(`Build returned before PID marker: ${JSON.stringify(outcome)}`);
   return false;
  }, 180000);
  console.error('EOF marker reached:', leafPid);
  const chain = await chainFor(leafPid, child.pid);
  const start = Date.now(); child.stdin.end();
  await waitGone(chain);
  report.results.push({test:'stdin EOF during build',passed:true,elapsedMs:Date.now()-start,chain,diagnostics});
 } finally { if (alive(child.pid)) await execFileAsync(taskkill,['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{}); }
}

try { await cancellation(); await eof(); }
catch (error) { report.error=error.stack; process.exitCode=1; }
finally {
 // Every PID here was validated as a descendant of a server created by this script.
 for (const pid of [...owned].reverse()) if (alive(pid)) await execFileAsync(taskkill,['/PID',String(pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
 report.remainingPids=[...owned].filter(alive);
 if (report.remainingPids.length) process.exitCode=1;
 await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}

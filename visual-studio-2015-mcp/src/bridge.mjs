import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const active = new Set();

function terminate(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else child.kill('SIGKILL');
}

export function stopChildren() {
  const pending = [...active];
  for (const record of pending) record.stop(new Error('Server disconnected; stopping the tool.'));
  return Promise.allSettled(pending.map(record => record.closed));
}

export function invokeBackend(request, { signal, script = 'Invoke-Vs2015.ps1', desktopX86 = false,
  cooperativeStopFile, cleanupGraceMs = 45000, preserveBackendErrors = false } = {}) {
  if (process.platform !== 'win32') throw new Error('This server requires Windows and PowerShell 7.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const executable = desktopX86
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : process.env.VS2015_MCP_PWSH || 'pwsh.exe';
    const child = spawn(executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(scripts, script)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let closed;
    const record = { closed: new Promise(resolve => { closed = resolve; }), stop: null };
    active.add(record);
    let stdout = '', stderr = '', failure, cleanupTimer;
    const fail = error => {
      if (failure) return;
      failure = error;
      if (cooperativeStopFile) {
        try { writeFileSync(cooperativeStopFile, new Date().toISOString(), { flag: 'wx' }); }
        catch (writeError) { if (writeError.code !== 'EEXIST') failure.message += ` Stop marker failed: ${writeError.message}`; }
        cleanupTimer = setTimeout(() => terminate(child), cleanupGraceMs);
      } else terminate(child);
    };
    record.stop = fail;
    const abort = () => fail(new Error('Request cancelled; stopping the tool process tree.'));
    const timer = setTimeout(() => fail(new Error('PowerShell bridge exceeded its deadline.')),
      (request.timeoutMs ?? 120000) + (request.setupTimeoutMs ?? 60000) + 30000);
    signal?.addEventListener('abort', abort, { once: true });
    // JSON escaping can expand each retained native character to six bytes.
    const limit = Math.max(2097152, (request.maxOutputChars ?? 64000) * 14);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (stdout.length + data.length > limit) fail(new Error('Backend response exceeded its output limit.'));
      else stdout += data;
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      active.delete(record);
      closed();
      if (failure) {
        try { failure.backendResult = JSON.parse(stdout.replace(/^\uFEFF/, '')); } catch { /* hard termination may have no result */ }
        return reject(failure);
      }
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (result.error && preserveBackendErrors) return resolve(result);
        if (result.error) {
          const error = new Error(`${result.error.code}: ${result.error.message}`);
          error.backendResult = result;
          return reject(error);
        }
        if (code !== 0) return reject(new Error(`PowerShell exited ${code}: ${stderr}`));
        resolve(result);
      } catch (error) {
        reject(new Error(`Invalid backend response (PowerShell exit ${code}): ${error.message}. ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) abort();
  });
}

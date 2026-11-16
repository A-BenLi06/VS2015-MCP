import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  for (const child of active) terminate(child);
}

export function invokeBackend(request, { signal, script = 'Invoke-Vs2015.ps1' } = {}) {
  if (process.platform !== 'win32') throw new Error('This server requires Windows and PowerShell 7.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.VS2015_MCP_PWSH || 'pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(scripts, script)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    active.add(child);
    let stdout = '', stderr = '', failure;
    const fail = error => { failure ??= error; terminate(child); };
    const abort = () => fail(new Error('Request cancelled; stopping the tool process tree.'));
    const timer = setTimeout(() => fail(new Error('PowerShell bridge exceeded its deadline.')),
      (request.timeoutMs ?? 120000) + 90000);
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
      signal?.removeEventListener('abort', abort);
      active.delete(child);
      if (failure) return reject(failure);
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (result.error) return reject(new Error(`${result.error.code}: ${result.error.message}`));
        if (code !== 0) return reject(new Error(`PowerShell exited ${code}: ${stderr}`));
        resolve(result);
      } catch (error) {
        reject(new Error(`Invalid backend response: ${error.message}. ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) abort();
  });
}

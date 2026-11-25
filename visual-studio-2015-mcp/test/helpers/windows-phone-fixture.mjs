import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));
export const fixtureTestTimeoutMs = 55_000;

export async function runPhoneFixture(name, t) {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root) throw new Error('SystemRoot is required to locate 32-bit Windows PowerShell.');
  const shell = path.join(root, 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL(`../fixtures/${name}.ps1`, import.meta.url));
  const started = performance.now();
  try {
    const { stdout, stderr } = await execute(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-ScriptsDirectory', scripts,
    ], { windowsHide: true, maxBuffer: 1048576, timeout: 45_000, signal: t.signal });
    if (process.env.CI && stderr.trim()) t.diagnostic(`${name}: ${stderr.trim()}`);
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch (error) {
    const elapsed = Math.round(performance.now() - started);
    const phases = error.stderr?.trim() || 'No fixture phase received.';
    throw new Error(`${name} failed after ${elapsed} ms. ${phases}`, { cause: error });
  }
}

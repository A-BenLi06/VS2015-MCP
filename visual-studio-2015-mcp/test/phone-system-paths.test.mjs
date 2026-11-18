import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
test('shared phone SDK discovery uses real Windows folders without OS directory environment variables',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const root=process.env.SystemRoot??process.env.SYSTEMROOT;assert.ok(root);
  const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
  const fixture=fileURLToPath(new URL('./fixtures/Test-PhoneSystemPaths.ps1',import.meta.url));
  const {stdout}=await promisify(execFile)(path.join(root,'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',fixture,'-ScriptsDirectory',scripts],{windowsHide:true,maxBuffer:1048576});
  const result=JSON.parse(stdout.replace(/^\uFEFF/,''));assert.equal(result.passed,true);assert.equal(result.environmentStillAbsent,true);assert.ok(path.isAbsolute(result.windows)&&path.isAbsolute(result.programFilesX86));
});

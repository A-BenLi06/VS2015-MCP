import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
test('phone VM discovery uses one exact snapshot and keeps legacy status usable without Hyper-V access',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const windows=process.env.SystemRoot??process.env.SYSTEMROOT??process.env.windir??'C:\\Windows';
  const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));const fixture=fileURLToPath(new URL('./fixtures/Test-PhoneVmDiscovery.ps1',import.meta.url));
  const {stdout}=await promisify(execFile)(path.join(windows,'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',fixture,'-ScriptsDirectory',scripts],{windowsHide:true,maxBuffer:1048576});
  const result=JSON.parse(stdout.replace(/^\uFEFF/,''));assert.equal(result.passed,true);assert.equal(result.checks,11);assert.equal(result.unavailableStatus.vmId,null);assert.equal(result.unavailableStatus.shellReady,true);assert.equal(result.unavailableStatus.identityUnavailable.code,'PHONE_VM_QUERY_FAILED');
});

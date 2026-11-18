import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdeBridgeClient } from '../../src/ide-client.mjs';
const product=process.env.VS2015_TEST_PRODUCT_ROOT??fileURLToPath(new URL('../../',import.meta.url));
const fixturePath=process.env.VS2015_TEST_PHONE_GUARD_IDE;
const enabled=process.platform==='win32'&&fixturePath;
function run(command,args,input=''){return new Promise((resolve,reject)=>{const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Phone guard test helper timeout'));},90000);child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);code?reject(new Error(stdout+' '+stderr)):resolve(stdout);});child.stdin.end(input);});}
async function build(){const value=JSON.parse(await run(process.env.VS2015_MCP_PWSH??'pwsh.exe',['-NoProfile','-File',path.join(product,'scripts/Build-IdeBridge.ps1')],'{}'));assert.ok(value.executablePath,value.error?.message);return value;}
test('phone debug guard contract and drift checks run against the compiled bridge',{skip:!enabled,timeout:180000},async()=>{
  const built=await build(),scratch=await mkdtemp(path.join(os.tmpdir(),'v15-phone-guard-'));
  const executable=path.join(scratch,'PhoneDebugGuardTests.exe');
  await run(path.join(process.env.SystemRoot,'Microsoft.NET/Framework/v4.0.30319/csc.exe'),['/nologo','/utf8output','/platform:x86','/reference:System.Web.Extensions.dll','/out:'+executable,path.join(product,'test/fixtures/PhoneDebugGuardTests.cs')]);
  const value=JSON.parse(await run(executable,[built.executablePath]));assert.equal(value.passed,true);assert.equal(value.checks,29);
});
test('owned phone IDE rejects stale guard assertions before issuing Go',{skip:!enabled,timeout:240000},async()=>{
  const relative=path.relative(os.tmpdir(),path.resolve(fixturePath));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  const fixture=JSON.parse(await readFile(fixturePath,'utf8'));assert.equal(fixture.ownsIde,true);
  const built=await build();const client=new IdeBridgeClient({launch:()=>spawn(built.executablePath,[],{windowsHide:true,stdio:['pipe','pipe','pipe']})});let sessionId;
  const call=(operation,input={})=>client.request(operation,{sessionId,...input},{timeoutMs:60000});
  try {
    sessionId=(await call('attach',{processId:fixture.processId,expectedStartTimeUtc:fixture.startTimeUtc})).sessionId;
    const state=await call('solutionStatus');assert.equal(state.debugger.mode,'design');
    assert.deepEqual(state.startupProjects.map(name=>name.toLowerCase()),[fixture.projectUniqueName.toLowerCase()]);
    const source=await call('projectAppIdentity',{projectUniqueName:fixture.projectUniqueName,manifestPath:fixture.manifestPath});
    assert.ok(source.applications.some(app=>app.id===fixture.applicationId));
    const property=await call('projectProperties',{projectUniqueName:fixture.projectUniqueName,propertyName:fixture.targetPropertyName,scope:fixture.scope});
    assert.equal(property.properties.length,1);assert.equal(property.properties[0].available,true);
    assert.equal(property.properties[0].value.toLowerCase(),fixture.deviceId.toLowerCase());
    const expected={configurationToken:state.configurationToken,projectUniqueName:source.projectUniqueName,targetPropertyName:fixture.targetPropertyName,scope:fixture.scope,deviceId:fixture.deviceId,manifestPath:source.manifestPath,manifestSha256:source.manifestSha256,applicationId:fixture.applicationId};
    const cases=[
      [{...expected,configurationToken:'stale-configuration-token'},'CONFIGURATION_CONFLICT'],
      [{...expected,manifestSha256:(expected.manifestSha256[0]==='a'?'b':'a')+expected.manifestSha256.slice(1)},'PHONE_MANIFEST_BINDING_CONFLICT'],
      [{...expected,applicationId:expected.applicationId+'.not-included'},'PHONE_APPLICATION_BINDING_CONFLICT'],
      [{...expected,deviceId:'00000000-0000-0000-0000-000000000000'},'PHONE_DEVICE_TARGET_CONFLICT'],
      [{...expected,targetGuards:[{name:expected.targetPropertyName,scope:expected.scope,value:'changed-device-property'}]},'PHONE_TARGET_GUARD_CONFLICT'],
    ];
    for(const [guard,code] of cases){await assert.rejects(call('debugControl',{action:'go',expectedPhoneBinding:guard}),{code});assert.equal((await call('debugState')).mode,'design');}
  } finally {
    try{if(sessionId){try{const state=await call('debugState');if(state.mode!=='design')await call('debugControl',{action:'stop'});}finally{await call('detach').catch(()=>{});}}}
    finally{await client.stop();}
  }
});

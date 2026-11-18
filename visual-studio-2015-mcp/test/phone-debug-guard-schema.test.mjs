import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl=process.env.VS2015_TEST_PRODUCT_ROOT?pathToFileURL(path.join(process.env.VS2015_TEST_PRODUCT_ROOT,'src/ide.mjs')):new URL('../src/ide.mjs',import.meta.url);
const {ideDefinitions}=await import(moduleUrl);
const definition=ideDefinitions.find(value=>value.name==='vs2015_ide_debug_control');
const binding=()=>({configurationToken:'observed-configuration-token',projectUniqueName:'Phone/Actual.csproj',targetPropertyName:'Observed.TargetGuid',scope:'activeConfiguration',deviceId:'11111111-2222-3333-4444-555555555555',manifestPath:'C:/owned/Package.appxmanifest',manifestSha256:'a'.repeat(64),applicationId:'ActualApp',targetGuards:[{name:'Observed.TargetKind',scope:'project',value:true},{name:'Observed.OptionalProperty',scope:'activeConfiguration',value:null}]});
test('IDE debug-control schema preserves complete expected phone binding and target assertions',()=>{
  const expected=binding();const result=definition.schema.parse({sessionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',action:'go',expectedPhoneBinding:expected});
  assert.deepEqual(result.expectedPhoneBinding,expected,'Nested expectedPhoneBinding was stripped before IDE dispatch.');
});
test('IDE debug-control schema rejects incomplete phone binding rather than downgrading to unguarded Go',()=>{
  const incomplete=binding();delete incomplete.applicationId;
  assert.equal(definition.schema.safeParse({sessionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',action:'go',expectedPhoneBinding:incomplete}).success,false);
});
test('legacy explicit debug commands remain unbound when no phone binding was supplied',()=>{
  const result=definition.schema.parse({sessionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',action:'stop'});
  assert.equal(result.expectedPhoneBinding,undefined);
});

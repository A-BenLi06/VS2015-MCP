import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath,pathToFileURL } from 'node:url';
const product=process.env.VS2015_TEST_PRODUCT_ROOT??fileURLToPath(new URL('../../',import.meta.url));
const {Client}=await import(pathToFileURL(path.join(product,'node_modules/@modelcontextprotocol/client/dist/index.mjs')));
const {StdioClientTransport}=await import(pathToFileURL(path.join(product,'node_modules/@modelcontextprotocol/client/dist/stdio.mjs')));
const fixturePath=process.env.VS2015_TEST_PHONE_SESSION_MANIFEST;
test('public phone discovery and legacy status return the owned VM GUID needed to open a session',{skip:process.platform!=='win32'||!fixturePath,timeout:180000},async()=>{
  const relative=path.relative(os.tmpdir(),path.resolve(fixturePath));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  const owned=JSON.parse(await readFile(fixturePath,'utf8'));assert.equal(owned.ownsXde,true);assert.match(owned.vmId,/^[a-f0-9-]{36}$/i);
  const client=new Client({name:'phone-vm-guid-discovery',version:'1'});
  const call=async(name,args={})=>{const value=await client.callTool({name,arguments:args},{timeout:120000});assert.equal(value.isError,false,JSON.stringify(value));return value.structuredContent;};
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(product,'src/server.mjs')],cwd:product}));
    const discovered=await call('phone_discover');assert.equal(discovered.vmIdentitySnapshot.available,true);
    const rows=discovered.running.filter(row=>row.processId===owned.processId);assert.equal(rows.length,1);const row=rows[0];
    assert.equal(Date.parse(row.startTimeUtc),Date.parse(owned.startTimeUtc));assert.equal(row.vmId.toLowerCase(),owned.vmId.toLowerCase());assert.equal(row.identityUnavailable,null);assert.ok(Number.isFinite(Date.parse(row.vmIdentityObservedAtUtc)));
    const status=await call('phone_status',{processId:owned.processId});
    assert.equal(status.vmId.toLowerCase(),owned.vmId.toLowerCase());assert.equal(status.identityUnavailable,null);assert.equal(status.vmName,row.vmName);assert.equal(Date.parse(status.startTimeUtc),Date.parse(owned.startTimeUtc));assert.ok(typeof status.shellReady==='boolean');
  }finally{await client.close();}
});

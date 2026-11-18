import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath,pathToFileURL } from 'node:url';
const product=process.env.VS2015_TEST_PRODUCT_ROOT??fileURLToPath(new URL('../../',import.meta.url));
const {Client}=await import(pathToFileURL(path.join(product,'node_modules/@modelcontextprotocol/client/dist/index.mjs')));
const {StdioClientTransport}=await import(pathToFileURL(path.join(product,'node_modules/@modelcontextprotocol/client/dist/stdio.mjs')));

test('legacy phone discovery and optional screenshots work without inherited OS directory variables',{skip:process.platform!=='win32',timeout:300000},async t=>{
  const client=new Client({name:'phone-minimal-environment',version:'1'});
  // Intentionally override the SDK's safe inherited variables with empty
  // values. No full process.env copy may hide the compatibility regression.
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(product,'src/server.mjs')],cwd:product,env:{PROGRAMFILES:'','PROGRAMFILES(X86)':'',PROGRAMW6432:'',WINDIR:''}});
  const call=async(name,args={})=>{const value=await client.callTool({name,arguments:args},{timeout:180000,signal:t.signal});assert.equal(value.isError,false,JSON.stringify(value));return value;};
  try{
    await client.connect(transport);
    const discovered=(await call('phone_discover')).structuredContent;
    assert.ok(Array.isArray(discovered.xde)&&Array.isArray(discovered.tools)&&Array.isArray(discovered.running));
    const ownedManifest=process.env.VS2015_TEST_PHONE_SESSION_MANIFEST;
    await t.test('capture through original one-shot MCP tool with explicit owned XDE identity',{skip:!ownedManifest},async()=>{
      const relative=path.relative(os.tmpdir(),path.resolve(ownedManifest));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
      const owned=JSON.parse(await readFile(ownedManifest,'utf8'));assert.equal(owned.ownsXde,true);
      const actual=discovered.running.filter(row=>row.processId===owned.processId);assert.equal(actual.length,1);assert.equal(Date.parse(actual[0].startTimeUtc),Date.parse(owned.startTimeUtc));
      const state=(await call('phone_status',{processId:owned.processId})).structuredContent;assert.ok(state.display.width>0&&state.display.height>0);
      const scratch=await mkdtemp(path.join(os.tmpdir(),'vs-phone-minimal-env-'));const output=path.join(scratch,'owned-guest.png');
      const first=await call('phone_screenshot',{processId:owned.processId,path:output,includeImage:true});assert.ok(first.content.some(row=>row.type==='image'&&row.mimeType==='image/png'));
      const replaced=await call('phone_screenshot',{processId:owned.processId,path:output,includeImage:false});
      assert.equal(replaced.structuredContent.path,output);assert.equal(replaced.structuredContent.width,state.display.width);assert.equal(replaced.structuredContent.height,state.display.height);
      assert.equal((await readFile(output)).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      // Retain the UUID-scoped artifact for diagnosis; never reuse a prior
      // semantic UI evidence path when testing capture replacement.
      t.diagnostic(`Minimal-env legacy screenshot: ${output}`);
    });
  }finally{await client.close();}
});

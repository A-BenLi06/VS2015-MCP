import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const URL='https://windbg.download.prss.microsoft.com/dbazure/prod/1-2611-4001-0/windbg.msixbundle';
const VERSION='1.2611.4001.0';
const destination=path.resolve(process.argv[2]||'');
if(!process.argv[2]||!path.isAbsolute(process.argv[2])) throw new Error('Absolute staging directory required.');
if(await fs.stat(destination).catch(()=>null))throw new Error('Staging destination must not exist.');
const maxDownload=32*1024*1024;
let downloaded=0,etag,totalSize;
async function getRange(a,b){
  if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<a||b>=totalSize||downloaded+b-a+1>maxDownload)throw new Error('Invalid range or download budget exceeded.');
  const r=await fetch(URL,{headers:{Range:`bytes=${a}-${b}`,'If-Match':etag},redirect:'error',signal:AbortSignal.timeout(60000)});
  if(r.status!==206||r.headers.get('content-range')!==`bytes ${a}-${b}/${totalSize}`||r.headers.get('etag')!==etag)throw new Error('Server did not preserve bounded range and ETag.');
  const chunks=[];let count=0;
  for await(const chunk of r.body){count+=chunk.length;if(count>b-a+1)throw new Error('Oversized range response.');chunks.push(chunk);}
  if(count!==b-a+1)throw new Error('Incomplete range response.');downloaded+=count;return Buffer.concat(chunks);
}
function number64(buffer,index){const n=Number(buffer.readBigUInt64LE(index));if(!Number.isSafeInteger(n))throw new Error('ZIP64 integer exceeds safe precision.');return n;}
async function directory(base,size){
  const tailStart=Math.max(0,size-65557),tail=await getRange(base+tailStart,base+size-1);let end=-1;
  for(let i=tail.length-22;i>=0;i--){if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}}
  if(end<0)throw new Error('ZIP end record absent.');let length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
  if(length===0xffffffff||offset===0xffffffff){if(end<20||tail.readUInt32LE(end-20)!==0x07064b50)throw new Error('ZIP64 locator absent.');const zo=number64(tail,end-12);const z=await getRange(base+zo,base+zo+55);if(z.readUInt32LE(0)!==0x06064b50)throw new Error('Invalid ZIP64 end record.');length=number64(z,40);offset=number64(z,48);}
  if(length>2*1024*1024||offset+length>size)throw new Error('ZIP directory outside permitted bounds.');const buf=await getRange(base+offset,base+offset+length-1),entries=[];
  for(let i=0;i<buf.length;){if(i+46>buf.length||buf.readUInt32LE(i)!==0x02014b50)throw new Error('Invalid ZIP directory.');const nl=buf.readUInt16LE(i+28),xl=buf.readUInt16LE(i+30),cl=buf.readUInt16LE(i+32);if(i+46+nl+xl+cl>buf.length)throw new Error('Truncated ZIP entry.');const entry={name:buf.toString('utf8',i+46,i+46+nl),flags:buf.readUInt16LE(i+8),method:buf.readUInt16LE(i+10),crc:buf.readUInt32LE(i+16),compressedLength:buf.readUInt32LE(i+20),length:buf.readUInt32LE(i+24),offset:buf.readUInt32LE(i+42)};if([entry.length,entry.compressedLength,entry.offset].includes(0xffffffff))throw new Error('ZIP64 entry fields unsupported.');entries.push(entry);if(entries.length>10000)throw new Error('Too many archive entries.');i+=46+nl+xl+cl;}return entries;
}
async function dataOffset(base,entry){const local=await getRange(base+entry.offset,base+entry.offset+29);if(local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(8)!==entry.method)throw new Error('ZIP local header mismatch.');return base+entry.offset+30+local.readUInt16LE(26)+local.readUInt16LE(28);}
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function crc32(data){let c=0xffffffff;for(const v of data)c=(c>>>8)^crcTable[(c^v)&255];return (c^0xffffffff)>>>0;}
async function readEntry(base,entry){if(entry.flags&1||entry.length>64*1024*1024)throw new Error('Unsupported encrypted/large entry.');const start=await dataOffset(base,entry);const compressed=await getRange(start,start+entry.compressedLength-1);const bytes=entry.method===0?compressed:entry.method===8?inflateRawSync(compressed,{maxOutputLength:entry.length}):null;if(!bytes||bytes.length!==entry.length||crc32(bytes)!==entry.crc)throw new Error('Decompression or CRC failure: '+entry.name);return bytes;}

const head=await fetch(URL,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(60000)});if(head.status!==200)throw new Error('Package HEAD failed.');totalSize=Number(head.headers.get('content-length'));etag=head.headers.get('etag');if(!Number.isSafeInteger(totalSize)||!etag)throw new Error('Missing immutable range metadata.');
const outer=await directory(0,totalSize),packages=outer.filter(e=>e.name==='windbg_win-x64.msix');if(packages.length!==1||packages[0].method!==0)throw new Error('Expected one uncompressed x64 MSIX.');const packageBase=await dataOffset(0,packages[0]);const entries=await directory(packageBase,packages[0].length);
const files=new Set(['cdb.exe','dbgeng.dll','dbghelp.dll','dbgcore.dll','dbgmodel.dll','symsrv.dll','srcsrv.dll','msdia140.dll','manifest.1.xml','manifestversion.txt','NOTICE.txt','triage/triage.ini','triage/pooltag.txt','winext/ext.dll','winext/uext.dll','winext/kext.dll','winxp/exts.dll','winxp/ntsdexts.dll','winxp/wow64exts.dll','OptionalExtensions/ext_GalleryManifest.xml']);
for(const e of entries)if(/^amd64\/winext\/Microsoft\.Diagnostics\.Analysis\.[A-Za-z0-9_.-]+\.dll$/.test(e.name))files.add(e.name.slice(6));
const selected=[...files].map(name=>{const matches=entries.filter(e=>e.name==='amd64/'+name);if(matches.length!==1)throw new Error('Required entry absent or duplicated: '+name);return matches[0];});
const expected=selected.reduce((sum,e)=>sum+e.compressedLength+30,0);if(expected+downloaded>maxDownload)throw new Error('Selected files exceed transfer budget.');await fs.mkdir(destination,{recursive:true});
const records=[];for(const entry of selected){const bytes=await readEntry(packageBase,entry),relative=entry.name.slice(6);const output=path.resolve(destination,...relative.split('/'));const fromRoot=path.relative(destination,output);if(fromRoot==='..'||fromRoot.startsWith('..'+path.sep)||path.isAbsolute(fromRoot))throw new Error('Archive output escapes staging directory.');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes,{flag:'wx'});records.push({archiveEntry:entry.name,path:relative,length:bytes.length,compressedLength:entry.compressedLength,crc32:entry.crc.toString(16).padStart(8,'0'),sha256:createHash('sha256').update(bytes).digest('hex')});process.stderr.write(`Downloaded ${relative}\n`);}
const manifest={schemaVersion:1,version:VERSION,sourceUrl:URL,sourceLength:totalSize,sourceETag:etag,nestedPackage:packages[0].name,downloadedBytes:downloaded,downloadBudget:maxDownload,createdUtc:new Date().toISOString(),signatureVerified:false,files:records};await fs.writeFile(path.join(destination,'download-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});console.log(JSON.stringify(manifest));

import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { validateMobilePortal } from '../test/helpers/portal-validation.mjs';
import { phoneDefinitions } from '../src/phone.mjs';
import { PortalClient } from '../src/portal-client.mjs';

async function preflight(contextPath) {
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  const call = async (name, input) => { const tool = phoneDefinitions.find(item => item.name === name); return tool.run(tool.schema.parse(input), {}); };
  const status = await call('phone_status', { processId: context.processId });
  if (status.startTimeUtc !== context.startTimeUtc || status.vmId?.toLowerCase() !== context.vmId?.toLowerCase())
    throw new Error('Emulator identity changed. Refresh the context before pairing.');
  if (!status.shellReady || !status.toolsReady) throw new Error('The emulator shell and tools must be ready before pairing.');
  const endpoint = await call('phone_endpoint', { processId: context.processId });
  if (new URL(context.baseUrl).hostname !== endpoint.guestAddress) throw new Error('The Portal address does not match the current guest endpoint.');
  const client = await new PortalClient({ baseUrl: context.baseUrl, caPath: context.caPath, certificateSha256: context.certificateSha256 }).initialize();
  try { await client.request('/authenticate.htm', { responseType: 'discard', timeoutMs: 15000 }); }
  finally { client.close(); }
  console.log('Portal preflight passed: emulator identity, address, TLS and pairing page are reachable.');
}

const preflightOnly = process.argv[2] === '--preflight';
const prompt = preflightOnly ? null : createInterface({ input: process.stdin, output: process.stdout });
try {
  if (preflightOnly) await preflight(process.argv[3]);
  else {
    const result = await validateMobilePortal(process.argv[2], {
    signal: AbortSignal.timeout(600000),
    onDirectory(directory) { console.log(`MCP evidence directory: ${directory}`); },
    async selectProfile(profiles) {
      console.log('Profile catalog returned by this device:');
      console.log(JSON.stringify(profiles, null, 2));
      return (await prompt.question('JSON Pointer to the value the device uses for capture (FileName on Mobile 14393): ')).trim();
    },
  });
    console.log(JSON.stringify({ completed: true, ...result }, null, 2));
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { prompt?.close(); }

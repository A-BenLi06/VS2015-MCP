import { createInterface } from 'node:readline/promises';
import { validateMobilePortal } from '../test/helpers/portal-validation.mjs';

const prompt = createInterface({ input: process.stdin, output: process.stdout });
try {
  const result = await validateMobilePortal(process.argv[2], {
    signal: AbortSignal.timeout(600000),
    onDirectory(directory) { console.log(`MCP evidence directory: ${directory}`); },
    async selectProfile(profiles) {
      console.log('Profile catalog returned by this device:');
      console.log(JSON.stringify(profiles, null, 2));
      return (await prompt.question('JSON Pointer to the profile name to capture for five seconds: ')).trim();
    },
  });
  console.log(JSON.stringify({ completed: true, ...result }, null, 2));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { prompt.close(); }

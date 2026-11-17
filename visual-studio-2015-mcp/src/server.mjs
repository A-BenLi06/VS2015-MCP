#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { definitions, asToolResult } from './tools.mjs';
import { stopChildren } from './bridge.mjs';
import { phoneDefinitions } from './phone.mjs';
import { readFile } from 'node:fs/promises';
import { observabilityDefinitions, recordingTool } from './observability.mjs';
import { diagnosticDefinitions } from './diagnostics.mjs';
import { debugDefinitions } from './debug.mjs';
import { profilerDefinitions } from './profiler.mjs';
import { ideDefinitions } from './ide.mjs';
import { stopIdeBridge } from './ide-client.mjs';

serveStdio(() => {
  const server = new McpServer({ name: 'visual-studio-2015', version: '0.2.1' });
  for (const name of ['cli-guide', 'phone-guide', 'diagnostics-performance', 'debug-guide', 'mobile-performance']) {
    server.registerResource(name, `vs2015://${name}`, { mimeType: 'text/markdown' }, async uri => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readFile(new URL(`../docs/${name}.md`, import.meta.url), 'utf8') }],
    }));
  }
  const catalog = [...definitions, ...phoneDefinitions, ...observabilityDefinitions, ...diagnosticDefinitions, ...debugDefinitions, ...profilerDefinitions, ...ideDefinitions];
  for (const tool of [...catalog, recordingTool(catalog)]) {
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.schema,
      annotations: { readOnlyHint: Boolean(tool.readOnly), destructiveHint: !tool.readOnly, openWorldHint: !tool.readOnly },
    }, async (input, context) => {
      try {
        const result = await tool.run(input, { signal: context.mcpReq.signal });
        return tool.formatResult ? await tool.formatResult(result, input) : asToolResult(result);
      }
      catch (error) { return asToolResult({ error: { message: error.message } }); }
    });
  }
  return server;
});
const stop = () => Promise.allSettled([stopChildren(), stopIdeBridge()]);
process.stdin.on('end', stop);
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await stop(); process.exit(0); });
process.on('exit', stop);

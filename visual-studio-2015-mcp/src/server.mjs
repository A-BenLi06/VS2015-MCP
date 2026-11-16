#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { definitions, asToolResult } from './tools.mjs';
import { stopChildren } from './bridge.mjs';

serveStdio(() => {
  const server = new McpServer({ name: 'visual-studio-2015', version: '0.1.0' });
  for (const tool of definitions) {
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.schema,
      annotations: { readOnlyHint: Boolean(tool.readOnly), destructiveHint: !tool.readOnly, openWorldHint: !tool.readOnly },
    }, async (input, context) => {
      try { return asToolResult(await tool.run(input, { signal: context.mcpReq.signal })); }
      catch (error) { return asToolResult({ error: { message: error.message } }); }
    });
  }
  return server;
});
process.stdin.on('end', stopChildren);
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { stopChildren(); process.exit(0); });
process.on('exit', stopChildren);

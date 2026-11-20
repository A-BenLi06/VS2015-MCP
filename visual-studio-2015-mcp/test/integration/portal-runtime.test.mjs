import test from 'node:test';
import { validateMobilePortal } from '../helpers/portal-validation.mjs';

const contextPath = process.env.VS2015_TEST_WIN10M_PORTAL_CONTEXT;
test('owned Mobile Portal public MCP reads guest data and collects an explicitly selected profile', {
  skip: process.platform !== 'win32' || !contextPath, timeout: 600000,
}, async t => {
  const result = await validateMobilePortal(contextPath, { signal: t.signal });
  t.diagnostic(`Portal evidence ${result.receiptPath}; MCP results ${result.directory}`);
});

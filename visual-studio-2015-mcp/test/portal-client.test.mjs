import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PortalClient, portalOrigin, portalEtlEvidence } from '../src/portal-client.mjs';

async function server(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
test('Portal origins and HTTP credentials are explicit; secrets are not returned', async t => {
  for (const value of ['http://u:p@localhost', 'file:///tmp/x', 'http://localhost/path', 'https://localhost/?x=1']) assert.throws(() => portalOrigin(value));
  await assert.rejects(new PortalClient({ baseUrl: 'http://localhost' }).initialize(), { code: 'PORTAL_HTTP_CONSENT_REQUIRED' });
  let seen;
  const baseUrl = await server(t, (q, r) => { seen = q.headers.authorization; r.end('{}'); });
  process.env.PORTAL_TEST_USERNAME = 'user'; process.env.PORTAL_TEST_PASSWORD = 'secret';
  t.after(() => { delete process.env.PORTAL_TEST_USERNAME; delete process.env.PORTAL_TEST_PASSWORD; });
  const c = await new PortalClient({ baseUrl, allowInsecureHttp: true, usernameEnv: 'PORTAL_TEST_USERNAME', passwordEnv: 'PORTAL_TEST_PASSWORD' }).initialize();
  const result = await c.request('/api/os/info'); assert.equal(seen, 'Basic ' + Buffer.from('user:secret').toString('base64'));
  assert.ok(!JSON.stringify(result).includes('secret')); c.close(); await assert.rejects(c.request('/'), { code: 'PORTAL_CLOSED' });
});
test('Portal refuses redirects without forwarding credentials and distinguishes unsupported/auth errors', async t => {
  let redirected = 0;
  const other = await server(t, (q, r) => { redirected++; r.end('{}'); });
  const baseUrl = await server(t, (q, r) => { r.writeHead(Number(q.url.slice(1)), { Location: other }); r.end(); });
  const c = await new PortalClient({ baseUrl, allowInsecureHttp: true }).initialize();
  for (const [status, code] of [[302, 'PORTAL_REDIRECT_REFUSED'], [401, 'PORTAL_AUTH_REQUIRED'], [404, 'PORTAL_UNSUPPORTED'], [500, 'PORTAL_HTTP_ERROR']])
    await assert.rejects(c.request('/' + status), { code, operationMayContinue: false });
  assert.equal(redirected, 0);
});
test('Portal carries only CSRF cookies and encodes exact query values', async t => {
  const calls = [];
  const baseUrl = await server(t, (q, r) => { calls.push({ url: q.url, headers: q.headers }); r.setHeader('Set-Cookie', ['CSRF-Token=nonce; Path=/; HttpOnly', 'unrelated=secret']); r.end('{}'); });
  const c = await new PortalClient({ baseUrl, allowInsecureHttp: true }).initialize();
  await c.request('/api/os/info'); await c.request('/api/wpr/trace', { method: 'POST', query: { profile: 'CPU + 中文&x' }, mutation: true });
  assert.equal(calls[0].headers['csrf-token'], 'Fetch'); assert.equal(calls[1].headers['x-csrf-token'], 'nonce');
  assert.equal(calls[1].headers.cookie, 'CSRF-Token=nonce'); assert.equal(new URL(calls[1].url, baseUrl).searchParams.get('profile'), 'CPU + 中文&x');
});
test('Portal timeout and aborted download do not replay; incomplete files are removed', async t => {
  let calls = 0;
  const baseUrl = await server(t, (q, r) => { calls++; r.writeHead(200); r.write('partial'); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  const c = await new PortalClient({ baseUrl, allowInsecureHttp: true }).initialize();
  await assert.rejects(c.request('/api/wpr/trace', { destination: path.join(root, 'trace.etl'), mutation: true, timeoutMs: 100 }), { code: 'PORTAL_TIMEOUT', operationMayContinue: true });
  assert.equal(calls, 1); assert.deepEqual(await readdir(root), []);
  const controller = new AbortController(); controller.abort(); await assert.rejects(c.request('/', { signal: controller.signal }), { operationMayContinue: false }); assert.equal(calls, 1);
});
test('Portal streams exact ETL bytes and enforces response/header limits', async t => {
  const bytes = Buffer.alloc(4096); bytes.writeUInt32LE(4096, 0); bytes.writeUInt32LE(512, 4);
  const baseUrl = await server(t, (q, r) => { if (q.url === '/bad') r.end('<html>bad</html>'); else r.end(bytes); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-etl-')); t.after(() => rm(root, { recursive: true, force: true }));
  const c = await new PortalClient({ baseUrl, allowInsecureHttp: true }).initialize();
  const result = await c.request('/', { destination: path.join(root, 'trace.etl') }); assert.deepEqual(await readFile(result.path), bytes);
  assert.equal(portalEtlEvidence(result).eventContentValidated, false);
  await assert.rejects(c.request('/', { maxBytes: 256 }), { code: 'PORTAL_RESPONSE_TOO_LARGE' });
  await assert.rejects(c.request('/bad'), { code: 'PORTAL_RESPONSE_INVALID' });
  assert.throws(() => portalEtlEvidence({ bytes: 4096, prefix: Buffer.from('<html>response</html>') }), { code: 'PORTAL_ETL_INVALID' });
});

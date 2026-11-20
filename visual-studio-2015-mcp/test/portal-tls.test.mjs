import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PortalClient } from '../src/portal-client.mjs';

async function fixture(t, name = 'legacy-cert.pem') {
  const key = await readFile(new URL('./fixtures/portal-tls/test-key.pem', import.meta.url));
  const cert = await readFile(new URL('./fixtures/portal-tls/' + name, import.meta.url));
  const calls = [];
  const server = https.createServer({ key, cert }, (q, r) => { calls.push(q.headers); r.end('{"connected":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `https://127.0.0.1:${server.address().port}`;
  const certificateSha256 = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
  return { baseUrl, certificateSha256, calls };
}

test('explicit leaf pin verifies legacy TLS before HTTP or credentials are sent', async t => {
  const f = await fixture(t);
  const standard = await new PortalClient({ baseUrl: f.baseUrl }).initialize();
  await assert.rejects(standard.request('/'), { code: 'PORTAL_CONNECTION_FAILED' });
  const wrong = await new PortalClient({ baseUrl: f.baseUrl, certificateSha256: '0'.repeat(64) }).initialize();
  wrong.authorization = 'Basic test-must-not-be-sent';
  await assert.rejects(wrong.request('/', { method: 'POST', mutation: true }), { code: 'PORTAL_CERTIFICATE_MISMATCH', operationMayContinue: false });
  assert.equal(f.calls.length, 0);
  const pinned = await new PortalClient(f).initialize();
  assert.deepEqual((await pinned.request('/')).data, { connected: true });
  assert.equal(f.calls.length, 1);
});

test('a correct pin still rejects expired and not-yet-valid certificates before dispatch', async t => {
  for (const name of ['expired-cert.pem', 'future-cert.pem']) {
    const f = await fixture(t, name), c = await new PortalClient(f).initialize();
    await assert.rejects(c.request('/', { method: 'POST', mutation: true }), { code: 'PORTAL_CERTIFICATE_EXPIRED', operationMayContinue: false });
    assert.equal(f.calls.length, 0);
  }
});

test('pinned TLS handshake honors deadlines and cancellation without dispatch', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  const c = await new PortalClient({ baseUrl: `https://127.0.0.1:${server.address().port}`, certificateSha256: '0'.repeat(64) }).initialize();
  await assert.rejects(c.request('/', { mutation: true, timeoutMs: 100 }), { code: 'PORTAL_TIMEOUT', operationMayContinue: false });
  const controller = new AbortController();
  const request = c.request('/', { mutation: true, signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { code: 'PORTAL_CANCELLED', operationMayContinue: false });
});

test('pin configuration rejects HTTP, malformed fingerprints and mixed trust modes', async () => {
  for (const config of [
    { baseUrl: 'http://127.0.0.1', allowInsecureHttp: true, certificateSha256: '0'.repeat(64) },
    { baseUrl: 'https://127.0.0.1', certificateSha256: 'invalid' },
    { baseUrl: 'https://127.0.0.1', certificateSha256: '0'.repeat(64), caPath: 'unused.pem' },
  ]) await assert.rejects(new PortalClient(config).initialize(), { code: 'PORTAL_TLS_CONFIG_INVALID' });
});

test('Mobile pairing uses one nonpersistent request and keeps root-scoped cookies private', async t => {
  const key = await readFile(new URL('./fixtures/portal-tls/test-key.pem', import.meta.url));
  const cert = await readFile(new URL('./fixtures/portal-tls/legacy-cert.pem', import.meta.url));
  const calls = [];
  const server = https.createServer({ key, cert }, (q, r) => {
    const url = new URL(q.url, 'https://fixture'); calls.push({ url, headers: q.headers });
    if (url.pathname === '/authenticate.htm') { r.setHeader('Set-Cookie', 'CSRF-Token=csrf; Path=/; Secure'); return r.end('Pair page'); }
    if (url.pathname === '/api/authorize/pair') {
      assert.equal(q.method, 'POST'); assert.equal(url.searchParams.get('pin'), 'aB12Z9'); assert.equal(url.searchParams.get('persistent'), '0');
      assert.equal(q.headers['x-csrf-token'], 'csrf'); assert.equal(q.headers.cookie, 'CSRF-Token=csrf');
      r.setHeader('Set-Cookie', ['MobileSession=private-token; Path=/; Secure; HttpOnly', 'Foreign=bad; Domain=elsewhere.test; Path=/', 'Narrow=bad; Path=/other']);
      return r.end();
    }
    assert.equal(q.headers.cookie, 'CSRF-Token=csrf; MobileSession=private-token'); r.end('{"authenticated":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  process.env.PORTAL_TEST_PAIRING_PIN = 'aB12Z9'; t.after(() => delete process.env.PORTAL_TEST_PAIRING_PIN);
  const c = await new PortalClient({ baseUrl: `https://127.0.0.1:${server.address().port}`, pairingPinEnv: 'PORTAL_TEST_PAIRING_PIN',
    certificateSha256: new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase() }).initialize();
  await c.pairMobile(); const result = await c.request('/api/os/info');
  assert.deepEqual(result.data, { authenticated: true }); assert.equal(calls.length, 3);
  assert.ok(!JSON.stringify(result).includes('private-token')); assert.ok(!JSON.stringify(result).includes('aB12Z9'));
  c.close(); assert.equal(c.cookies.size, 0);
});

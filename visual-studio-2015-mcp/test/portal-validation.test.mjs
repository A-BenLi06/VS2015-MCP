import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialEnvironment } from './helpers/portal-validation.mjs';

test('public Portal validation passes only explicitly named credential variables to its server', t => {
  process.env.PORTAL_FIXTURE_PIN = 'aB12Z9';
  process.env.PORTAL_UNRELATED_SECRET = 'unrelated';
  t.after(() => { delete process.env.PORTAL_FIXTURE_PIN; delete process.env.PORTAL_UNRELATED_SECRET; });
  assert.deepEqual(credentialEnvironment({ pairingPinEnv: 'PORTAL_FIXTURE_PIN' }), { PORTAL_FIXTURE_PIN: 'aB12Z9' });
  assert.deepEqual(credentialEnvironment({}), {});
  assert.throws(() => credentialEnvironment({ pairingPinEnv: 'NOT SET' }));
  assert.throws(() => credentialEnvironment({ passwordEnv: 'PORTAL_ABSENT_FIXTURE_VARIABLE' }));
});

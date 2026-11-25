import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTestTimeoutMs, runPhoneFixture } from './helpers/windows-phone-fixture.mjs';

test('persistent phone lifecycle keeps one input client and releases only held keys', { skip: process.platform !== 'win32', timeout: fixtureTestTimeoutMs }, async t => {
  const result = await runPhoneFixture('Test-PhoneSessionLifecycle', t);
  assert.equal(result.passed, true); assert.equal(result.checks, 11);
  assert.equal(result.firstSession.client, 1); assert.equal(result.firstSession.input, 1);
  assert.deepEqual(result.close.unreleasedKeys, []); assert.equal(result.close.vmClosed, false);
  assert.deepEqual(result.eof.unreleasedKeys, []);
});

test('CoreCon profile binding requires both SDK endpoint addresses and preserves connection ownership', { skip: process.platform !== 'win32', timeout: fixtureTestTimeoutMs }, async t => {
  const result = await runPhoneFixture('Test-PhoneBinding', t);
  assert.equal(result.passed, true); assert.equal(result.checks, 11);
  assert.equal(result.preexistingConnectionLog, 'client:dispose');
});

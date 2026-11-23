import test from 'node:test';
import assert from 'node:assert/strict';
import { portalWprStatus, portalSystemPerformance } from '../src/portal-responses.mjs';
import { portalFingerprint } from '../src/portal-client.mjs';

test('WPR recognizes observed Mobile fields and the documented arrangement without guessing unknown states', () => {
  for (const [native, normalized] of [['Idle', 'idle'], ['Running', 'recording']]) {
    for (const mode of ['normal', 'boot']) {
      const raw = { State: native, SessionType: mode };
      assert.deepEqual(portalWprStatus(raw), { state: normalized, mode, responseFormat: 'state-status', raw, fingerprint: portalFingerprint(raw) });
      assert.equal(portalWprStatus({ State: mode, SessionType: native }).state, normalized);
      assert.equal(portalWprStatus({ State: mode, SessionType: native }).mode, mode);
    }
  }
  for (const raw of [null, {}, { State: 'Idle' }, { State: 'Idle', SessionType: 'Idle' }, { State: 'Idle', SessionType: 'unknown' }, { State: 'Stopping', SessionType: 'normal' }]) {
    assert.equal(portalWprStatus(raw).state, 'unknown'); assert.equal(portalWprStatus(raw).mode, null);
  }
});

test('system performance decodes Mobile JSON-in-Reason while preserving raw evidence and unknown fields', () => {
  const data = { CpuLoad: 1, PageSize: 4096, TotalPages: 262029, GPUData: { AvailableAdapters: [] }, FutureCounter: 42 };
  assert.deepEqual(portalSystemPerformance(data), { data, responseFormat: 'json' });
  const raw = { Reason: JSON.stringify(data) };
  assert.deepEqual(portalSystemPerformance(raw), { data, rawData: raw, responseFormat: 'json-in-reason' });
  for (const raw of [{ Reason: 'native failure' }, { Reason: '[]' }, { Reason: 'null' }, { Reason: JSON.stringify(data), ErrorCode: 5 }, {}, { CpuLoad: '1', PageSize: 4096 }])
    assert.throws(() => portalSystemPerformance(raw), { code: 'PORTAL_PERFORMANCE_INVALID' });
});

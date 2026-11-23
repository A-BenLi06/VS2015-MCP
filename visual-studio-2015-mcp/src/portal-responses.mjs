import { PortalError, portalFingerprint } from './portal-client.mjs';

export function portalWprStatus(raw) {
  const states = { Idle: 'idle', Running: 'recording' };
  const modes = ['normal', 'boot'];
  // Mobile 14393 returns State=Idle/Running and SessionType=normal/boot.
  // The REST reference documents the opposite field arrangement. Accept only
  // complete, recognized pairs; preserve unknown responses without guessing.
  const deviceFormat = Object.hasOwn(states, raw?.State ?? '') && modes.includes(raw?.SessionType);
  const referenceFormat = Object.hasOwn(states, raw?.SessionType ?? '') && modes.includes(raw?.State);
  return {
    state: deviceFormat ? states[raw.State] : referenceFormat ? states[raw.SessionType] : 'unknown',
    mode: deviceFormat ? raw.SessionType : referenceFormat ? raw.State : null,
    responseFormat: deviceFormat ? 'state-status' : referenceFormat ? 'session-type-status' : 'unknown',
    raw, fingerprint: portalFingerprint(raw),
  };
}

export function portalSystemPerformance(raw) {
  let data = raw, responseFormat = 'json';
  if (raw && Object.keys(raw).length === 1 && typeof raw.Reason === 'string') {
    try { data = JSON.parse(raw.Reason); responseFormat = 'json-in-reason'; }
    catch { data = null; }
  }
  // These are protocol fields, not translated UI labels. Require an actual
  // numeric performance observation instead of treating arbitrary Reason text
  // or a native failure as a successful metrics response.
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isFinite(data.CpuLoad) ||
      !Number.isSafeInteger(data.PageSize) || data.PageSize <= 0)
    throw new PortalError('PORTAL_PERFORMANCE_INVALID', 'Device Portal did not return a recognized system performance observation.', { details: { rawData: raw } });
  return { data, responseFormat, ...(responseFormat === 'json-in-reason' ? { rawData: raw } : {}) };
}

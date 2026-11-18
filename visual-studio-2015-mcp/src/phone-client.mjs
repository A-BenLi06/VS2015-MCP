import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export class PhoneBridgeError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'PhoneBridgeError'; this.code = code; Object.assign(this, details); }
}
const cancelled = operationMayContinue => new PhoneBridgeError('PHONE_REQUEST_CANCELLED',
  operationMayContinue ? 'The request was cancelled after dispatch. The phone emulator operation may continue; inspect its state before retrying.' : 'The queued request was cancelled before dispatch.', { operationMayContinue });

/** A single STA bridge owns one serialized command queue. No request is replayed. */
export class PhoneBridgeClient {
  constructor({ launch, maxMessageBytes = 1024 * 1024, maxQueueLength = 64, initializationTimeoutMs = 120000, cleanupGraceMs = 3000 } = {}) {
    if (typeof launch !== 'function') throw new TypeError('launch must create an owned bridge process.');
    if (!Number.isInteger(initializationTimeoutMs) || initializationTimeoutMs < 1 || initializationTimeoutMs > 600000) throw new RangeError('initializationTimeoutMs must be 1..600000.');
    if (!Number.isInteger(cleanupGraceMs) || cleanupGraceMs < 1 || cleanupGraceMs > 30000) throw new RangeError('cleanupGraceMs must be 1..30000.');
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 128 || maxMessageBytes > 8 * 1024 * 1024) throw new RangeError('maxMessageBytes must be 128..8388608.');
    if (!Number.isInteger(maxQueueLength) || maxQueueLength < 1 || maxQueueLength > 1024) throw new RangeError('maxQueueLength must be 1..1024.');
    this.launch = launch; this.maxMessageBytes = maxMessageBytes; this.maxQueueLength = maxQueueLength;
    this.initializationTimeoutMs = initializationTimeoutMs; this.startAttempt = null;
    this.child = null; this.ready = false; this.starting = null; this.queue = []; this.active = null; this.closed = false;
    this.buffer = Buffer.alloc(0); this.stderr = ''; this.stopPromise = null;
    this.cleanupGraceMs = cleanupGraceMs; this.retiring = null; this.lastShutdown = null;
  }
  async ensureStarted() {
    if (this.closed) throw new PhoneBridgeError('PHONE_BRIDGE_CLOSED', 'The phone emulator bridge client is closed.');
    if (this.retiring) await this.retiring;
    if (this.closed) throw new PhoneBridgeError('PHONE_BRIDGE_CLOSED', 'The phone emulator bridge client is closed.');
    if (this.child && this.ready) return;
    if (!this.starting) {
      const attempt = { controller: new AbortController() }; this.startAttempt = attempt;
      const { signal } = attempt.controller;
      let abortListener;
      const timer = setTimeout(() => attempt.controller.abort(new PhoneBridgeError('PHONE_INITIALIZATION_TIMEOUT',
        'phone emulator bridge initialization exceeded its separate deadline. No phone emulator command was dispatched.')), this.initializationTimeoutMs);
      const aborted = new Promise((resolve, reject) => {
        abortListener = () => reject(signal.reason); signal.addEventListener('abort', abortListener, { once: true });
      });
      const launched = Promise.resolve().then(() => this.launch({ signal })).then(child => {
        // A launcher may not support AbortSignal. Never adopt its late child.
        if (signal.aborted || this.closed || this.startAttempt !== attempt) {
          child.kill(); throw signal.reason ?? new PhoneBridgeError('PHONE_BRIDGE_CLOSED', 'The phone emulator bridge closed while starting.');
        }
        return new Promise((resolve, reject) => {
          attempt.readyResolve = () => resolve(child); attempt.readyReject = reject;
          this.child = child; this.ready = false; this.buffer = Buffer.alloc(0); this.stderr = '';
          child.stdout.on('data', chunk => this.receive(child, chunk));
          child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16000); });
          child.stdin.on('error', error => this.fail(child, new PhoneBridgeError('PHONE_BRIDGE_IO', error.message)));
          child.on('error', error => this.fail(child, new PhoneBridgeError('PHONE_BRIDGE_START_FAILED', error.message)));
          child.on('close', code => this.fail(child, new PhoneBridgeError('PHONE_BRIDGE_RESET',
            `Phone emulator bridge exited (${code}); its session IDs are invalid. Open a new session.`, { bridgeStderr: this.stderr })));
        });
      });
      this.starting = Promise.race([launched, aborted]).catch(error => {
        if (this.startAttempt === attempt) this.fail(this.child, error);
        throw error;
      }).finally(() => {
        clearTimeout(timer); signal.removeEventListener('abort', abortListener);
        if (this.startAttempt === attempt) { this.startAttempt = null; this.starting = null; }
      });
    }
    await this.starting;
  }
  request(operation, input = {}, { signal, timeoutMs = 15000 } = {}) {
    if (this.closed) return Promise.reject(new PhoneBridgeError('PHONE_BRIDGE_CLOSED', 'The phone emulator bridge client is closed.'));
    if (signal?.aborted) return Promise.reject(cancelled(false));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) return Promise.reject(new RangeError('timeoutMs must be 1..600000.'));
    if (this.queue.length + (this.active ? 1 : 0) >= this.maxQueueLength) return Promise.reject(new PhoneBridgeError('PHONE_QUEUE_FULL', 'The phone emulator bridge request queue is full.'));
    return new Promise((resolve, reject) => {
      const item = { id: randomUUID(), operation, input, signal, resolve, reject, settled: false, dispatched: false, timer: null, timeoutMs, abort: null };
      const settle = (method, value) => { if (!item.settled) { item.settled = true; method(value); } };
      item.success = value => settle(resolve, value); item.failure = error => settle(reject, error);
      item.abort = () => {
        item.failure(cancelled(item.dispatched));
        if (!item.dispatched) { this.queue = this.queue.filter(other => other !== item); this.cleanup(item); }
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
      if (this.child && this.ready) this.armDeadline(item);
      if (signal?.aborted) item.abort();
      void this.pump();
    });
  }
  cleanup(item) { clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.abort); }
  armDeadline(item) {
    if (item.timer || item.settled) return;
    item.timer = setTimeout(() => {
      if (item.dispatched) this.fail(this.child, new PhoneBridgeError('PHONE_BRIDGE_TIMEOUT',
        'The emulator request exceeded its deadline. Its operation may continue. Session IDs are invalid; the controller is receiving EOF to release its held keys before bounded termination.', { operationMayContinue: true, cleanupStatus: 'pending' }));
      else { item.failure(new PhoneBridgeError('PHONE_QUEUE_TIMEOUT', 'The request expired in the initialized bridge queue.')); this.queue = this.queue.filter(other => other !== item); this.cleanup(item); }
    }, item.timeoutMs);
  }
  async pump() {
    if (this.active || !this.queue.length || this.closed) return;
    try { await this.ensureStarted(); }
    catch (error) { const items = this.queue.splice(0); for (const item of items) { this.cleanup(item); item.failure(error); } return; }
    // Several request() calls can await the same startup promise.
    if (this.active || !this.queue.length || this.closed || !this.child || !this.ready) return;
    // Compilation/startup has its own deadline. Queue/execution budgets begin
    // only after initialization; requests waiting behind work remain bounded.
    for (const waiting of this.queue) this.armDeadline(waiting);
    const item = this.queue.shift();
    if (item.settled) { this.cleanup(item); void this.pump(); return; }
    this.active = item; item.dispatched = true;
    let bytes;
    try { bytes = Buffer.from(JSON.stringify({ ...item.input, id: item.id, operation: item.operation }) + '\n'); }
    catch (error) { this.active = null; this.cleanup(item); item.failure(error); void this.pump(); return; }
    if (bytes.length > this.maxMessageBytes) { this.active = null; this.cleanup(item); item.failure(new PhoneBridgeError('PHONE_REQUEST_TOO_LARGE', 'phone emulator request exceeds its byte limit.')); void this.pump(); return; }
    this.child.stdin.write(bytes);
  }
  receive(child, chunk) {
    if (child !== this.child) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const end = this.buffer.indexOf(10);
      if ((end < 0 && this.buffer.length > this.maxMessageBytes) || end > this.maxMessageBytes) {
        this.fail(child, new PhoneBridgeError('PHONE_RESPONSE_TOO_LARGE', 'phone emulator response exceeds its byte limit; sessions have been invalidated.')); return;
      }
      if (end < 0) return;
      const line = this.buffer.subarray(0, end).toString('utf8').replace(/^\uFEFF/, '').trim();
      this.buffer = this.buffer.subarray(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(child, new PhoneBridgeError('PHONE_PROTOCOL_ERROR', 'The phone emulator bridge returned invalid JSON; sessions have been invalidated.')); return; }
      if (!this.ready) {
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.kind !== 'ready' || message.protocolVersion !== 1 || message.backend !== 'xde-session' || own(message, 'id')) {
          this.fail(child, new PhoneBridgeError('PHONE_PROTOCOL_ERROR', 'The phone emulator bridge did not send the expected readiness envelope.')); return;
        }
        this.ready = true; this.startAttempt.readyResolve(); continue;
      }
      const item = this.active;
      if (!message || typeof message !== 'object' || Array.isArray(message) || !item || message.id !== item.id ||
          (own(message, 'result') === own(message, 'error')) || (own(message, 'error') && (!message.error || typeof message.error !== 'object'))) {
        this.fail(child, new PhoneBridgeError('PHONE_PROTOCOL_ERROR', 'The phone emulator bridge returned an unexpected response ID or envelope.')); return;
      }
      this.active = null; this.cleanup(item);
      if (message.error) item.failure(new PhoneBridgeError(message.error.code || 'PHONE_OPERATION_FAILED', message.error.message || 'The phone emulator operation failed.', { backendError: message.error }));
      else item.success(message.result);
      void this.pump();
    }
  }
  fail(child, error) {
    if (child && child !== this.child) return;
    const owned = this.child; this.child = null; this.ready = false; this.buffer = Buffer.alloc(0);
    this.startAttempt?.readyReject?.(error);
    const items = [this.active, ...this.queue].filter(Boolean); this.active = null; this.queue = [];
    for (const item of items) { this.cleanup(item); item.failure(error); }
    // EOF runs the bridge's held-key cleanup. A hung SDK call gets a bounded
    // grace period before this controller alone is killed; never kill the VM.
    if (owned) this.retiring = this.retire(owned).finally(() => { this.retiring = null; });
  }
  async retire(child) {
    if (child.exitCode !== null || child.signalCode !== null) {
      this.lastShutdown = { forcedTermination: false, cleanupStatus: 'unknown', exitCode: child.exitCode, stderr: this.stderr };
      return this.lastShutdown;
    }
    let forcedTermination = false;
    await new Promise(resolve => {
      const timer = setTimeout(() => { forcedTermination = true; child.kill(); resolve(); }, this.cleanupGraceMs);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      try { child.stdin.end(); } catch { /* The process may already be exiting. */ }
    });
    this.lastShutdown = { forcedTermination, cleanupStatus: !forcedTermination && child.exitCode === 0 && !this.stderr.trim() ? 'completed' : 'unknown', exitCode: child.exitCode, stderr: this.stderr };
    return this.lastShutdown;
  }
  async waitForShutdown() { return this.retiring ? this.retiring : this.lastShutdown; }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.startAttempt?.controller.abort(new PhoneBridgeError('PHONE_BRIDGE_CLOSED', 'The MCP connection closed during bridge initialization.'));
    this.stopPromise = (async () => {
      const items = [this.active, ...this.queue].filter(Boolean); this.active = null; this.queue = [];
      for (const item of items) { this.cleanup(item); item.failure(new PhoneBridgeError('PHONE_BRIDGE_CLOSED', 'The MCP connection closed. The phone emulator is left running.')); }
      if (this.starting) await this.starting.catch(() => {});
      const child = this.child; this.child = null; this.ready = false;
      if (this.retiring) await this.retiring;
      if (child) return this.retire(child);
      return this.lastShutdown;
    })();
    return this.stopPromise;
  }
}

export function createPhoneBridgeLauncher({ scriptPath = fileURLToPath(new URL('../scripts/PhoneSessionBridge.ps1', import.meta.url)), environment = process.env } = {}) {
  return async ({ signal } = {}) => {
    if (process.platform !== 'win32') throw new PhoneBridgeError('PHONE_PLATFORM_UNSUPPORTED', 'XDE automation requires Windows.');
    if (!environment.SystemRoot) throw new PhoneBridgeError('PHONE_PLATFORM_UNSUPPORTED', 'SystemRoot is unavailable.');
    signal?.throwIfAborted();
    const executable = path.join(environment.SystemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  };
}
let singleton;
export function invokePhoneSession(operation, input = {}, ctx = {}) {
  singleton ??= new PhoneBridgeClient({ launch: createPhoneBridgeLauncher(), initializationTimeoutMs: Number(process.env.VS2015_MCP_PHONE_INITIALIZATION_TIMEOUT_MS ?? 120000) });
  return singleton.request(operation, input, { signal: ctx.signal, timeoutMs: input.timeoutMs ?? (operation === 'open' ? 30000 : 15000) });
}
export async function stopPhoneBridge() { if (singleton) return singleton.stop(); }


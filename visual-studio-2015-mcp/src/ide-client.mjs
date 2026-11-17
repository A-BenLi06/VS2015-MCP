import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { invokeBackend } from './bridge.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export class IdeBridgeError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'IdeBridgeError'; this.code = code; Object.assign(this, details); }
}
const cancelled = operationMayContinue => new IdeBridgeError('IDE_REQUEST_CANCELLED',
  operationMayContinue ? 'The request was cancelled after dispatch. The IDE operation may continue; inspect its state before retrying.' : 'The queued request was cancelled before dispatch.', { operationMayContinue });

/** A single STA bridge owns one serialized command queue. No request is replayed. */
export class IdeBridgeClient {
  constructor({ launch, maxMessageBytes = 8 * 1024 * 1024, maxQueueLength = 64 } = {}) {
    if (typeof launch !== 'function') throw new TypeError('launch must create an owned bridge process.');
    this.launch = launch; this.maxMessageBytes = maxMessageBytes; this.maxQueueLength = maxQueueLength;
    this.child = null; this.starting = null; this.queue = []; this.active = null; this.closed = false;
    this.buffer = Buffer.alloc(0); this.stderr = ''; this.stopPromise = null;
  }
  async ensureStarted() {
    if (this.closed) throw new IdeBridgeError('IDE_BRIDGE_CLOSED', 'The IDE bridge client is closed.');
    if (this.child) return;
    if (!this.starting) this.starting = (async () => {
      const child = await this.launch();
      if (this.closed) { child.kill(); throw new IdeBridgeError('IDE_BRIDGE_CLOSED', 'The IDE bridge closed while starting.'); }
      this.child = child; this.buffer = Buffer.alloc(0); this.stderr = '';
      child.stdout.on('data', chunk => this.receive(child, chunk));
      child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16000); });
      child.stdin.on('error', error => this.fail(child, new IdeBridgeError('IDE_BRIDGE_IO', error.message)));
      child.on('error', error => this.fail(child, new IdeBridgeError('IDE_BRIDGE_START_FAILED', error.message)));
      child.on('close', code => this.fail(child, new IdeBridgeError('IDE_BRIDGE_RESET',
        `IDE bridge exited (${code}); its session IDs are invalid. Attach again.`, { bridgeStderr: this.stderr })));
    })().finally(() => { this.starting = null; });
    await this.starting;
  }
  request(operation, input = {}, { signal, timeoutMs = 15000 } = {}) {
    if (this.closed) return Promise.reject(new IdeBridgeError('IDE_BRIDGE_CLOSED', 'The IDE bridge client is closed.'));
    if (signal?.aborted) return Promise.reject(cancelled(false));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) return Promise.reject(new RangeError('timeoutMs must be 1..600000.'));
    if (this.queue.length + (this.active ? 1 : 0) >= this.maxQueueLength) return Promise.reject(new IdeBridgeError('IDE_QUEUE_FULL', 'The IDE bridge request queue is full.'));
    return new Promise((resolve, reject) => {
      const item = { id: randomUUID(), operation, input, signal, resolve, reject, settled: false, dispatched: false, timer: null, abort: null };
      const settle = (method, value) => { if (!item.settled) { item.settled = true; method(value); } };
      item.success = value => settle(resolve, value); item.failure = error => settle(reject, error);
      item.abort = () => {
        item.failure(cancelled(item.dispatched));
        if (!item.dispatched) { this.queue = this.queue.filter(other => other !== item); this.cleanup(item); }
      };
      item.timer = setTimeout(() => {
        if (item.dispatched) this.fail(this.child, new IdeBridgeError('IDE_BRIDGE_TIMEOUT',
          'The IDE request exceeded its deadline. Only the bridge was terminated; the IDE operation may continue. All session IDs are invalid; attach again.', { operationMayContinue: true }));
        else { item.failure(new IdeBridgeError('IDE_QUEUE_TIMEOUT', 'The request expired before dispatch.')); this.queue = this.queue.filter(other => other !== item); this.cleanup(item); }
      }, timeoutMs);
      signal?.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
      if (signal?.aborted) item.abort();
      void this.pump();
    });
  }
  cleanup(item) { clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.abort); }
  async pump() {
    if (this.active || !this.queue.length || this.closed) return;
    try { await this.ensureStarted(); }
    catch (error) { const items = this.queue.splice(0); for (const item of items) { this.cleanup(item); item.failure(error); } return; }
    // Several request() calls can await the same startup promise.
    if (this.active || !this.queue.length || this.closed || !this.child) return;
    const item = this.queue.shift();
    if (item.settled) { this.cleanup(item); void this.pump(); return; }
    this.active = item; item.dispatched = true;
    let bytes;
    try { bytes = Buffer.from(JSON.stringify({ ...item.input, id: item.id, operation: item.operation }) + '\n'); }
    catch (error) { this.active = null; this.cleanup(item); item.failure(error); void this.pump(); return; }
    if (bytes.length > this.maxMessageBytes) { this.active = null; this.cleanup(item); item.failure(new IdeBridgeError('IDE_REQUEST_TOO_LARGE', 'IDE request exceeds its byte limit.')); void this.pump(); return; }
    this.child.stdin.write(bytes);
  }
  receive(child, chunk) {
    if (child !== this.child) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const end = this.buffer.indexOf(10);
      if ((end < 0 && this.buffer.length > this.maxMessageBytes) || end > this.maxMessageBytes) {
        this.fail(child, new IdeBridgeError('IDE_RESPONSE_TOO_LARGE', 'IDE response exceeds its byte limit; sessions have been invalidated.')); return;
      }
      if (end < 0) return;
      const line = this.buffer.subarray(0, end).toString('utf8').replace(/^\uFEFF/, '').trim();
      this.buffer = this.buffer.subarray(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(child, new IdeBridgeError('IDE_PROTOCOL_ERROR', 'The IDE bridge returned invalid JSON; sessions have been invalidated.')); return; }
      const item = this.active;
      if (!message || typeof message !== 'object' || Array.isArray(message) || !item || message.id !== item.id ||
          (own(message, 'result') === own(message, 'error')) || (own(message, 'error') && (!message.error || typeof message.error !== 'object'))) {
        this.fail(child, new IdeBridgeError('IDE_PROTOCOL_ERROR', 'The IDE bridge returned an unexpected response ID or envelope.')); return;
      }
      this.active = null; this.cleanup(item);
      if (message.error) item.failure(new IdeBridgeError(message.error.code || 'IDE_OPERATION_FAILED', message.error.message || 'The IDE operation failed.', { backendError: message.error }));
      else item.success(message.result);
      void this.pump();
    }
  }
  fail(child, error) {
    if (child && child !== this.child) return;
    const owned = this.child; this.child = null; this.buffer = Buffer.alloc(0);
    const items = [this.active, ...this.queue].filter(Boolean); this.active = null; this.queue = [];
    for (const item of items) { this.cleanup(item); item.failure(error); }
    // Terminate this controller only. Never taskkill /T: the IDE is not ours.
    if (owned && owned.exitCode === null) owned.kill();
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.stopPromise = (async () => {
      const items = [this.active, ...this.queue].filter(Boolean); this.active = null; this.queue = [];
      for (const item of items) { this.cleanup(item); item.failure(new IdeBridgeError('IDE_BRIDGE_CLOSED', 'The MCP connection closed. The IDE is left running.')); }
      if (this.starting) await this.starting.catch(() => {});
      const child = this.child; this.child = null;
      if (!child || child.exitCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    })();
    return this.stopPromise;
  }
}

let executablePromise, singleton;
async function launchBridge() {
  if (process.platform !== 'win32') throw new IdeBridgeError('IDE_PLATFORM_UNSUPPORTED', 'VS2015 IDE automation requires Windows.');
  if (!executablePromise) executablePromise = (process.env.VS2015_MCP_IDE_BRIDGE
    ? Promise.resolve(process.env.VS2015_MCP_IDE_BRIDGE)
    : invokeBackend({ timeoutMs: 90000, setupTimeoutMs: 0 }, { script: 'Build-IdeBridge.ps1' }).then(result => {
      if (!result.executablePath) throw new Error('Build-IdeBridge did not return executablePath.'); return result.executablePath;
    })).catch(error => { executablePromise = null; throw error; });
  const executable = await executablePromise;
  return spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
export function invokeIde(operation, input, ctx = {}) {
  singleton ??= new IdeBridgeClient({ launch: launchBridge });
  return singleton.request(operation, input, { signal: ctx.signal, timeoutMs: input.timeoutMs ?? 15000 });
}
export async function stopIdeBridge() { if (singleton) await singleton.stop(); }

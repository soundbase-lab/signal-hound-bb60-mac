// The BB60 driver: owns one worker process per open device and speaks
// JSON lines to it (protocol.md). Everything that can wedge — the vendor
// library, libusb, the USB cable — lives on the far side of that pipe, so a
// call that never answers costs one SIGKILL and a clean device error, never
// the plugin process.

import { spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_WORKER = fileURLToPath(
  new URL('./worker/bin/bb60-worker', import.meta.url)
);
const FAKE_WORKER = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url));
const INSTALL_SCRIPT = fileURLToPath(
  new URL('../install-signal-hound-library.sh', import.meta.url)
);

/** Where install-signal-hound-library.sh puts Signal Hound's library. */
export const LIBRARY_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'signal-hound-bb60'
);
// then the places someone following Signal Hound's own instructions would use
const LIBRARY_DIRS = [LIBRARY_DIR, '/usr/local/lib', '/opt/homebrew/lib'];
const isLibrary = (name) => /^libbb_api.*\.dylib$/.test(name);

/**
 * Signal Hound's BB60 API library on this Mac, or null. It is theirs to
 * distribute, so the user installs it and the plugin only goes looking:
 *
 *   1. the "Signal Hound library" plugin setting (a file, or a folder holding it)
 *   2. SB_BB60_LIBRARY
 *   3. where the install script puts it, then /usr/local/lib, /opt/homebrew/lib
 */
export function findLibrary(pluginConfig = {}, env = process.env) {
  const explicit = [pluginConfig.libraryPath, env.SB_BB60_LIBRARY]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .map((p) => p.replace(/^~(?=\/)/, homedir()));
  for (const candidate of [...explicit, ...LIBRARY_DIRS]) {
    try {
      if (!statSync(candidate).isDirectory()) return candidate;
      // the highest version, when a folder holds several
      const found = readdirSync(candidate).filter(isLibrary).sort().at(-1);
      if (found) return join(candidate, found);
    } catch {
      // not there: try the next
    }
  }
  return null;
}

const SETUP_HINT = `Run "${INSTALL_SCRIPT}" in Terminal, or see the plugin's README, then try again.`;
const NO_LIBRARY = `Signal Hound's BB60 library is not installed on this Mac. ${SETUP_HINT}`;

/** A dlopen failure, as something an RF coordinator can act on. */
function describeLibraryError(detail) {
  if (/libusb/.test(detail)) {
    return 'Signal Hound\'s BB60 library needs libusb, which is not installed. Run "brew install libusb" in Terminal, then try again.';
  }
  return `Signal Hound's BB60 library could not be loaded (${detail.split('\n')[0].slice(0, 200)}). ${SETUP_HINT}`;
}

const LIST_TIMEOUT_MS = 3_000;
const OPEN_TIMEOUT_MS = 15_000; // a cold open loads firmware and calibrates
const CONFIG_TIMEOUT_MS = 30_000; // includes one real sweep at the new settings
const REQUEST_TIMEOUT_MS = 5_000;
const QUIT_GRACE_MS = 1_000;

/** Live workers, so a test can kill or freeze one the way a cable would. */
export const liveWorkers = new Set();

/**
 * How to start a worker: `{ command, args, mock }`, or null when there is no
 * native worker on this machine (a platform Signal Hound does not build for,
 * or a checkout where `npm run build:worker` has not been run).
 *
 *   SB_BB60_WORKER=<path>   an explicit worker; a .mjs/.js path runs under node
 *   SB_BB60_MOCK=1          the JavaScript fake — no hardware, any platform
 *   SB_BB60_MOCK=native     the native worker's own synthetic device
 */
export function resolveWorker(env = process.env) {
  const viaNode = (script) => ({
    command: process.execPath,
    args: [script],
    mock: true,
  });
  const explicit = env.SB_BB60_WORKER;
  if (explicit) {
    return /\.m?js$/.test(explicit)
      ? viaNode(explicit)
      : { command: explicit, args: [], mock: false };
  }
  if (env.SB_BB60_MOCK === 'native') {
    return existsSync(NATIVE_WORKER)
      ? { command: NATIVE_WORKER, args: ['--mock'], mock: true }
      : null;
  }
  if (env.SB_BB60_MOCK) return viaNode(FAKE_WORKER);
  if (!existsSync(NATIVE_WORKER)) return null;
  ensureExecutable(NATIVE_WORKER);
  return { command: NATIVE_WORKER, args: [], mock: false };
}

// An unzip that drops permission bits leaves a worker that exists and cannot
// be started. Put the bit back where the install lets us; where it does not,
// the spawn fails and says why.
function ensureExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    try {
      chmodSync(path, 0o755);
    } catch {
      // read-only install: nothing to do here
    }
  }
}

// process.execPath is Electron when SoundBase is the host; this makes it
// behave as node for the fake worker and is ignored by everything else
const workerEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1' });

/**
 * Attached devices, without opening any: `[{ serial, type, model }]`.
 * Never throws — nothing attached, no worker, and a worker that cannot start
 * are all "no devices" to discovery.
 */
export function listDevices(pluginConfig) {
  const worker = resolveWorker();
  if (!worker) return Promise.resolve([]);
  const args = [...worker.args];
  if (!worker.mock) {
    const library = findLibrary(pluginConfig);
    if (!library) {
      noteOnce(NO_LIBRARY);
      return Promise.resolve([]);
    }
    args.push('--lib', library);
  }
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (devices) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(devices);
    };
    const child = spawn(worker.command, [...args, '--list'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: workerEnv(),
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done([]);
    }, LIST_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => done([]));
    child.on('close', () => {
      try {
        const { devices, libraryError } = JSON.parse(out);
        if (libraryError) noteOnce(describeLibraryError(libraryError));
        done(Array.isArray(devices) ? devices : []);
      } catch {
        done([]);
      }
    });
  });
}

// Discovery finds nothing when the library is missing, and nothing is exactly
// what a user sees — so say why once, in the plugin log, rather than every
// second of every enumeration.
const noted = new Set();
function noteOnce(message) {
  if (noted.has(message)) return;
  noted.add(message);
  process.stderr.write(`[warn] ${message}\n`);
}

/** Turn "the worker died" into something an RF coordinator can act on. */
function describeExit(code, signal) {
  const how = signal ? `signal ${signal}` : `code ${code}`;
  return `The BB60 worker stopped unexpectedly (${how}). Check the USB cable, then reconnect the analyzer.`;
}

export class Bb60Worker {
  constructor() {
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closing = false;
    this.dead = false;
    /** assigned by the adapter */
    this.onTrace = null; // ({ gen, status, amps })
    this.onDiagnostics = null; // ({ tempC, usbVolts })
    this.onSweepError = null; // (Error) — sweeping stopped, device still open
    this.onFatal = null; // (Error) — the worker is gone, unprompted
  }

  /**
   * Start the worker process. Throws when there is no worker to start, or no
   * Signal Hound library for it to load.
   */
  start(pluginConfig) {
    const worker = resolveWorker();
    if (!worker) {
      throw new Error(
        process.platform === 'darwin' && process.arch === 'arm64'
          ? 'The BB60 worker has not been built. Run "npm run build:worker" in the plugin folder.'
          : 'Signal Hound provides the BB60 library for macOS on Apple Silicon only; this plugin cannot open a BB60 on this computer.'
      );
    }
    this.mock = worker.mock;
    const args = [...worker.args];
    if (!worker.mock) {
      const library = findLibrary(pluginConfig);
      if (!library) throw new Error(NO_LIBRARY);
      args.push('--lib', library);
    }
    const child = spawn(worker.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: workerEnv(),
    });
    this.child = child;
    liveWorkers.add(this);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.resume(); // the vendor library is entitled to print there too
    // a write to a worker that has just died must not take the plugin with it
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.#onGone(err.message));
    child.on('exit', (code, signal) =>
      this.#onGone(describeExit(code, signal))
    );
  }

  #onData(chunk) {
    this.buffer += chunk;
    let eol;
    while ((eol = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, eol);
      this.buffer = this.buffer.slice(eol + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // the vendor library is entitled to print to stdout
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    if (msg.ev === 'trace') return this.onTrace?.(msg);
    if (msg.ev === 'diag') return this.onDiagnostics?.(msg);
    if (msg.ev === 'error') {
      return this.onSweepError?.(new Error(msg.error || 'sweep failed'));
    }
    if (msg.ev === 'fatal') {
      this.fatalMessage = `The BB60 stopped responding (${msg.error}). Check the USB cable, then reconnect the analyzer.`;
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg);
    else {
      const err = new Error(
        msg.libraryError
          ? describeLibraryError(msg.libraryError)
          : msg.error || 'request failed'
      );
      err.setup = Boolean(msg.libraryError);
      err.status = msg.status;
      waiter.reject(err);
    }
  }

  #onGone(message) {
    if (this.dead) return;
    this.dead = true;
    liveWorkers.delete(this);
    const err = new Error(this.fatalMessage || message);
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
    if (!this.closing) this.onFatal?.(err);
  }

  #request(op, fields = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.dead || !this.child) {
      return Promise.reject(new Error('The BB60 worker is not running.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // No answer: the call is wedged in the vendor library or in USB, and
        // there is no interrupting it. Kill the worker; its exit rejects every
        // pending request and reports the device as failed.
        this.fatalMessage = `The BB60 did not answer within ${Math.round(timeoutMs / 1000)} s and was disconnected. Check the USB cable, then reconnect the analyzer.`;
        this.child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
    });
  }

  open(serial) {
    return this.#request('open', serial ? { serial } : {}, OPEN_TIMEOUT_MS);
  }

  configure(fields) {
    return this.#request('config', fields, CONFIG_TIMEOUT_MS);
  }

  startSweep() {
    return this.#request('start');
  }

  stopSweep() {
    return this.#request('stop');
  }

  /** Release the device. Idempotent, never throws, never waits on a hang. */
  async close() {
    if (this.dead || !this.child || this.closing) return;
    this.closing = true;
    const child = this.child;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    this.#request('quit', {}, QUIT_GRACE_MS).catch(() => {});
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), QUIT_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }
}

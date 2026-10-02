#!/usr/bin/env node
// A fake BB60 worker: speaks protocol.md exactly as the native worker does,
// with a synthetic spectrum in place of the analyzer. It is what the tests
// drive, on any platform, and what `SB_BB60_MOCK=1 npm start` serves — so the
// process plumbing in bb60-driver.js is under test, not mocked away.
//
// The spectrum is fixed in absolute frequency, like a real band: carriers at
// 518.1 MHz and 566.3 MHz, a transient at 543 MHz on one sweep in seven, and
// a noise floor that follows the RBW.

import { createInterface } from 'node:readline';

const SERIAL = 60000001;
const DEVICE = { serial: SERIAL, type: 2, model: 'BB60C' };
const MIN_HZ = 9_000;
const MAX_HZ = 6_400_000_000;
const CARRIERS = [
  [518_100_000, -45],
  [566_300_000, -60],
];
const TRANSIENT = [543_000_000, -40];
const SWEEP_MS = 15;

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

if (process.argv.includes('--list')) {
  emit({ devices: [DEVICE] });
  process.exit(0);
}

let open = false;
let configured = false;
let gen = 0;
let sweeps = 0;
let timer = null;
const config = {
  startHz: 470_000_000,
  stopHz: 616_000_000,
  pointCount: 451,
  rbwHz: 100_000,
  refLevelDbm: -20,
  detector: 'peak',
};

function sweep() {
  sweeps += 1;
  const { startHz, stopHz, pointCount, rbwHz } = config;
  const step = (stopHz - startHz) / (pointCount - 1);
  const floor = -150 + 10 * Math.log10(rbwHz);
  const signals = sweeps % 7 === 0 ? [...CARRIERS, TRANSIENT] : CARRIERS;
  const amps = new Array(pointCount);
  for (let i = 0; i < pointCount; i += 1) {
    const f = startHz + i * step;
    let amp = floor + Math.random() * 4 - 2;
    // a point owns half a step either side of it, so a carrier anywhere in
    // that bucket shows at full height — the peak reduction the real worker does
    for (const [hz, dbm] of signals) {
      if (Math.abs(f - hz) <= Math.max(step / 2, rbwHz)) amp = Math.max(amp, dbm);
    }
    amps[i] = Math.round(amp * 10) / 10;
  }
  emit({ ev: 'trace', gen, status: 0, amps });
}

function handle({ id, op, ...fields }) {
  const ok = (extra = {}) => emit({ id, ok: true, ...extra });
  const fail = (error) => emit({ id, ok: false, status: 0, error });
  switch (op) {
    case 'list':
      return ok({ devices: [DEVICE] });
    case 'open':
      if (fields.serial && fields.serial !== SERIAL) {
        return fail('Device not found');
      }
      open = true;
      return ok({ ...DEVICE, firmware: 7, apiVersion: 'fake' });
    case 'config': {
      if (!open) return fail('device is not open');
      for (const key of Object.keys(config)) {
        if (fields[key] !== undefined) config[key] = fields[key];
      }
      config.startHz = clamp(config.startHz, MIN_HZ, MAX_HZ);
      config.stopHz = clamp(config.stopHz, config.startHz + 20, MAX_HZ);
      config.pointCount = Math.max(2, Math.round(config.pointCount));
      config.rbwHz = clamp(config.rbwHz, 1_000, 10_000_000);
      config.refLevelDbm = Math.min(config.refLevelDbm, 20);
      configured = true;
      gen += 1;
      const binHz = config.rbwHz / 4;
      return ok({
        gen,
        ...config,
        deviceBins: Math.ceil((config.stopHz - config.startHz) / binHz) + 3,
        binHz,
        sweepMs: SWEEP_MS,
      });
    }
    case 'start':
      if (!configured) return fail('configure the sweep before starting it');
      timer ??= setInterval(sweep, SWEEP_MS);
      return ok();
    case 'stop':
      clearInterval(timer);
      timer = null;
      return ok();
    case 'quit':
      ok();
      return process.exit(0);
    default:
      return fail(`unknown op ${op}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (err) {
    emit({ id: 0, ok: false, status: 0, error: String(err?.message || err) });
  }
});
// the driver went away: so do we
lines.on('close', () => process.exit(0));

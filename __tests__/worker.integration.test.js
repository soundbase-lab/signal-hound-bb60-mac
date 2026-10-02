// The native worker, end to end, against its own synthetic device.
//
// bb60.test.js covers the adapter and driver with a JavaScript fake. This
// covers the part that fake stands in for: the compiled worker, the vendor
// library loading beside it, and the reduction of a device-sized trace onto
// the host's grid — the one piece of signal handling this plugin does itself.
//
// It needs `npm run build:worker`, which only produces anything on Apple
// Silicon. Anywhere else these tests are skipped, and say so.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Bb60Worker,
  findLibrary,
  listDevices,
  resolveWorker,
} from '../driver/bb60-driver.js';

process.env.SB_BB60_MOCK = 'native';
delete process.env.SB_BB60_WORKER;

const skip = resolveWorker()
  ? false
  : 'NOT RUN: no native worker here — run `npm run build:worker` (Apple Silicon only)';

const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;
const CARRIER_HZ = 518_100_000; // -45 dBm, a few RBWs wide
const indexOf = (hz, points) =>
  Math.round(((hz - START_HZ) / (STOP_HZ - START_HZ)) * (points - 1));

async function openWorker(t) {
  const worker = new Bb60Worker();
  worker.start();
  t.after(() => worker.close());
  await worker.open();
  return worker;
}

const nextTrace = (worker, gen) =>
  new Promise((resolve) => {
    worker.onTrace = (msg) => {
      if (msg.gen === gen) resolve(msg);
    };
  });

test('the worker lists a device without opening it', { skip }, async () => {
  const devices = await listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].model, 'BB60C');
  assert.ok(devices[0].serial > 0);
});

test('a carrier far narrower than a trace point survives the reduction', { skip }, async (t) => {
  const worker = await openWorker(t);
  const points = 451; // 324 kHz apiece
  const applied = await worker.configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: points,
    rbwHz: 10_000,
    detector: 'peak',
  });
  assert.ok(
    applied.deviceBins > points * 50,
    `the device sweeps ${applied.deviceBins} bins for ${points} points`
  );
  await worker.startSweep();
  const { amps } = await nextTrace(worker, applied.gen);

  assert.equal(amps.length, points);
  const at = indexOf(CARRIER_HZ, points);
  assert.ok(amps[at] > -47 && amps[at] <= -45, `carrier read ${amps[at]} dBm`);
  assert.ok(amps[at - 2] < -100, 'and only where the carrier is');
  assert.ok(amps[at + 2] < -100, 'and only where the carrier is');
});

test('the average detector reports mean power, below the peak', { skip }, async (t) => {
  const worker = await openWorker(t);
  const applied = await worker.configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 451,
    rbwHz: 10_000,
    detector: 'average',
  });
  assert.equal(applied.detector, 'average');
  await worker.startSweep();
  const { amps } = await nextTrace(worker, applied.gen);
  const at = indexOf(CARRIER_HZ, 451);
  assert.ok(amps[at] < -50 && amps[at] > -80, `carrier averaged to ${amps[at]}`);
});

test('more points than the device has bins still fills every point', { skip }, async (t) => {
  const worker = await openWorker(t);
  const applied = await worker.configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 2001,
    rbwHz: 10_000_000,
  });
  assert.ok(applied.deviceBins < 2001);
  await worker.startSweep();
  const { amps } = await nextTrace(worker, applied.gen);
  assert.equal(amps.length, 2001);
  assert.ok(amps.every((a) => Number.isFinite(a) && a > -200 && a < 30));
});

test('a reconfigure while sweeping switches grid without stopping', { skip }, async (t) => {
  const worker = await openWorker(t);
  const first = await worker.configure({ pointCount: 101, rbwHz: 100_000 });
  await worker.startSweep();
  assert.equal((await nextTrace(worker, first.gen)).amps.length, 101);
  const second = await worker.configure({ pointCount: 33 });
  assert.equal(second.rbwHz, 100_000, 'a config is a patch');
  assert.equal((await nextTrace(worker, second.gen)).amps.length, 33);
});

// Signal Hound's library is the user's to install. A Mac where it is missing
// or broken must get a worker that starts, answers, and says what to do.
test('a library that will not load is reported as setup, not as a crash', { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bb60-lib-'));
  const notALibrary = join(dir, 'libbb_api.5.0.11.dylib');
  writeFileSync(notALibrary, 'not a Mach-O file');
  delete process.env.SB_BB60_MOCK; // the real worker, really loading
  t.after(() => (process.env.SB_BB60_MOCK = 'native'));
  const pluginConfig = { libraryPath: dir };
  assert.equal(findLibrary(pluginConfig), notALibrary);

  assert.deepEqual(await listDevices(pluginConfig), []);

  const worker = new Bb60Worker();
  worker.start(pluginConfig);
  t.after(() => worker.close());
  await assert.rejects(worker.open(), (err) => {
    assert.equal(err.setup, true);
    assert.match(err.message, /could not be loaded/);
    assert.match(err.message, /install-signal-hound-library\.sh/);
    return true;
  });
  assert.equal(worker.dead, false, 'the worker is still there to be told to quit');
});

test('closing the worker releases it, and closing twice is harmless', { skip }, async (t) => {
  const worker = await openWorker(t);
  let fatal = null;
  worker.onFatal = (err) => (fatal = err);
  await worker.close();
  await worker.close();
  assert.equal(worker.dead, true);
  assert.equal(fatal, null, 'a close we asked for is not a failure');
});

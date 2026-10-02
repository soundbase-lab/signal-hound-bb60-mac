// Contract tests for the adapter, driven through the real shell over real HTTP.
//
// The analyzer is the fake worker in driver/fake-worker.mjs: a real child
// process speaking the real worker protocol, with a synthetic spectrum where
// the BB60 would be. So everything from the shell down to the pipe is under
// test, on any platform, with nothing plugged in. Read these as the executable
// half of docs/adapter-reference.md.
//
// Nothing here hardcodes the plugin's id: everything that could change when you
// run `npm run rename` is read from soundbase-plugin.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { PRODUCT, discoverDevices } from '../adapter.js';
import { liveWorkers } from '../driver/bb60-driver.js';

// the fake worker, not the native one: must be set before anything spawns
process.env.SB_BB60_MOCK = '1';
delete process.env.SB_BB60_WORKER;

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const FAKE_SERIAL = 60000001;
const DEVICE_ID = `usb:${FAKE_SERIAL}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;
const POINT_COUNT = 451;
// where the fake's spectrum puts things
const CARRIER_A_HZ = 518_100_000;
const CARRIER_B_HZ = 566_300_000;
const TRANSIENT_HZ = 543_000_000;

const indexOf = (hz) =>
  Math.round(((hz - START_HZ) / (STOP_HZ - START_HZ)) * (POINT_COUNT - 1));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const findDevice = async (id = DEVICE_ID) => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === id);
};

// discovery asks a child process, so the first listing can land a poll later
const waitForDevice = async (predicate = Boolean, id = DEVICE_ID) => {
  const deadline = Date.now() + 5_000;
  let device;
  while (Date.now() < deadline) {
    device = await findDevice(id);
    if (device && predicate(device)) return device;
    await delay(50);
  }
  return device;
};

test.after(() => handle.close());

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

// The rename trap: an adapter that announces a product the manifest does not
// declare produces a device the host silently ignores, and the only clue is one
// warning line in the plugin log. Catch it here instead.
test('every product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but soundbase-plugin.json declares only ` +
      `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`
  );
  assert.ok(
    PRODUCT.startsWith(`plugin:${manifest.id}/`),
    `a deviceTypeId is namespaced by the plugin id: expected ` +
      `plugin:${manifest.id}/… but adapter.js announces ${PRODUCT}`
  );
});

test('an attached analyzer is discovered under its serial number', async () => {
  const device = await waitForDevice();
  assert.ok(device, 'discovered');
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  assert.deepEqual(device.transport, {
    kind: 'usb',
    serial: String(FAKE_SERIAL),
  });
});

test('device ids are stable from one listing to the next', async () => {
  const first = await discoverDevices();
  const second = await discoverDevices();
  assert.deepEqual(
    first.map((d) => d.id),
    [DEVICE_ID]
  );
  assert.deepEqual(first, second);
});

test('no worker on this machine is an empty listing, not an error', async (t) => {
  process.env.SB_BB60_WORKER = '/nonexistent/bb60-worker';
  t.after(() => delete process.env.SB_BB60_WORKER);
  assert.deepEqual(await discoverDevices(), []);
});

// A *discovered* device is not opened until something asks it to do work — an
// idle plugin must not hold the analyzer. So `capabilities` is null in the
// first /devices listing and appears after the first operation on it.
test('open() reports capabilities the host can constrain its UI to', async () => {
  // The first configuration this device has seen, so also the defaults:
  // automatic points are on, and the echo carries the count they work out to
  // (three per RBW across the span, at the 10 kHz an automatic RBW resolves to).
  const first = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
  });
  assert.equal(first.body.controls.autoPoints, true);
  assert.equal(
    first.body.pointCount,
    ((STOP_HZ - START_HZ) / first.body.resolved.rbwHz) * 3 + 1
  );
  // every test from here on sets its own point count
  await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { autoPoints: false },
  });

  const device = await findDevice();
  const caps = device.capabilities;
  assert.ok(caps, 'capabilities appear once the device has been opened');
  assert.ok(caps.maxFrequencyHz > caps.minFrequencyHz);
  assert.ok(Array.isArray(caps.rbwHz) && caps.rbwHz.length > 0);
  assert.ok(
    Math.min(...caps.rbwHz) >= 1_000,
    'the Apple Silicon build of the vendor library sweeps no narrower than 1 kHz'
  );
  assert.deepEqual(
    caps.controls.map((c) => c.id),
    ['refLevelDbm', 'detector', 'autoPoints']
  );
  // the shell accumulates all four trace modes in software, so every device
  // advertises them whether or not the hardware has the feature
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);
});

test('config, start and trace produce a plausible spectrum', async (t) => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.startHz, START_HZ);
  assert.equal(applied.body.stopHz, STOP_HZ);
  assert.equal(applied.body.pointCount, POINT_COUNT);
  assert.equal(applied.body.rbwHz, 100_000);

  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.sweeping, true);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.pointCount, POINT_COUNT);
  assert.equal(trace.body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.body.startHz, START_HZ);
  assert.equal(trace.body.stopHz, STOP_HZ);
  assert.equal(trace.body.stepHz, (STOP_HZ - START_HZ) / (POINT_COUNT - 1));
  assert.equal(trace.body.unit, 'dBm');
  assert.ok(trace.body.sweepId >= 1);

  // Carriers must land on the frequency they are at, not merely exist: an
  // off-by-one in the trace geometry shifts every frequency on the plot and
  // still looks like a spectrum.
  const amps = trace.body.amplitudesDbm;
  const a = indexOf(CARRIER_A_HZ);
  const b = indexOf(CARRIER_B_HZ);
  const floorBins = [...amps.slice(10, 100), ...amps.slice(360, 440)];
  const floorMean = floorBins.reduce((x, y) => x + y, 0) / floorBins.length;
  assert.ok(floorMean < -90 && floorMean > -110, `noise floor at ${floorMean}`);
  assert.ok(amps[a] >= floorMean + 20, `carrier A only reached ${amps[a]}`);
  assert.ok(amps[b] >= floorMean + 20, `carrier B only reached ${amps[b]}`);
  assert.ok(amps[a - 3] < floorMean + 10, 'carrier A is where it should be');
  assert.ok(amps[b + 3] < floorMean + 10, 'carrier B is where it should be');
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const caps = (await findDevice()).capabilities;

  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 0,
    stopHz: caps.maxFrequencyHz * 10,
    pointCount: 99_999,
  });
  assert.equal(
    applied.status,
    200,
    'a request outside the range is still a 200'
  );
  assert.equal(applied.body.startHz, caps.minFrequencyHz);
  assert.equal(applied.body.stopHz, caps.maxFrequencyHz);
  assert.ok(applied.body.pointCount < 99_999);
});

test('an unsupported RBW snaps to the nearest supported value', async () => {
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 12_345,
  });
  assert.equal(body.rbwHz, 10_000);
});

// A 1 kHz RBW across the whole 6 GHz range is tens of millions of FFT bins a
// sweep. The user still gets a sweep; the echo says what it was swept at.
test('an RBW too narrow for the span is widened, and the echo says so', async () => {
  const caps = (await findDevice()).capabilities;
  const { status, body } = await request(
    'POST',
    `${DEVICE_PATH}/configuration`,
    {
      startHz: caps.minFrequencyHz,
      stopHz: caps.maxFrequencyHz,
      pointCount: POINT_COUNT,
      rbwHz: 1_000,
    }
  );
  assert.equal(status, 200);
  assert.ok(body.rbwHz > 1_000, `swept at ${body.rbwHz} Hz`);
  assert.ok(caps.rbwHz.includes(body.rbwHz));
});

test('an automatic RBW is reported as resolved, with the sweep time', async () => {
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: null, // back to automatic
  });
  assert.equal(body.rbwHz, undefined, 'the field stays "auto"');
  assert.ok(body.resolved.rbwHz >= 10_000, 'and auto resolved to a real value');
  assert.ok(body.resolved.sweepTimeMs > 0);
});

test('controls are clamped, merged by id, and echoed as the device took them', async () => {
  // +99 dBm is beyond the +20 dBm the analyzer accepts
  const first = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { refLevelDbm: 99 },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.controls.refLevelDbm, 20);
  assert.equal(first.body.controls.detector, 'peak');

  const second = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { detector: 'average' },
  });
  assert.equal(second.body.controls.detector, 'average');
  assert.equal(
    second.body.controls.refLevelDbm,
    20,
    'the untouched control survived'
  );

  const third = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { detector: 'quasi-peak', refLevelDbm: -20 },
  });
  assert.equal(
    third.body.controls.detector,
    'average',
    'an unknown choice leaves the detector as it was'
  );
  await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { detector: 'peak' },
  });
});

test('a retune leaves the bandwidth and the controls alone', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 30_000,
    controls: { refLevelDbm: -30 },
  });
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 500_000_000,
    stopHz: 550_000_000,
  });
  assert.equal(body.startHz, 500_000_000);
  assert.equal(body.stopHz, 550_000_000);
  assert.equal(body.pointCount, POINT_COUNT);
  assert.equal(body.rbwHz, 30_000);
  assert.equal(body.controls.refLevelDbm, -30);

  const read = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.deepEqual(read.body, body, 'GET reports what POST echoed');
});

// Automatic points: three per RBW across the span, whatever point count the
// host has saved — and the echo is how the host learns how many that is.
test('automatic points follow the span and RBW, and the trace matches', async (t) => {
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
    await request('POST', `${DEVICE_PATH}/configuration`, {
      startHz: START_HZ,
      stopHz: STOP_HZ,
      pointCount: POINT_COUNT,
      controls: { autoPoints: false },
    });
  });
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 500_000_000,
    stopHz: 510_000_000,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
    controls: { autoPoints: true },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.controls.autoPoints, true);
  assert.equal(applied.body.pointCount, (10_000_000 / 100_000) * 3 + 1);

  await request('POST', `${DEVICE_PATH}/sweep/start`);
  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.body.amplitudesDbm.length, 301);
  assert.equal(trace.body.startHz, 500_000_000);
  assert.equal(trace.body.stopHz, 510_000_000);

  // a narrower RBW or a wider span moves the count with it
  const narrower = await request('POST', `${DEVICE_PATH}/configuration`, {
    rbwHz: 10_000,
  });
  assert.equal(narrower.body.pointCount, 3_001);
  const wider = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 500_000_000,
    stopHz: 520_000_000,
  });
  assert.equal(wider.body.pointCount, 6_001);
  assert.equal(wider.body.controls.autoPoints, true, 'a retune leaves it on');
});

test('automatic points are capped on a wide span, and switch back off cleanly', async () => {
  const caps = (await findDevice()).capabilities;
  const wide = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: caps.minFrequencyHz,
    stopHz: caps.maxFrequencyHz,
    pointCount: POINT_COUNT,
    rbwHz: 10_000,
    controls: { autoPoints: true },
  });
  assert.equal(wide.status, 200);
  assert.equal(wide.body.pointCount, 50_001, 'not the 1.8 million it works out to');

  const manual = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    controls: { autoPoints: false },
  });
  assert.equal(manual.body.controls.autoPoints, false);
  assert.equal(
    manual.body.pointCount,
    POINT_COUNT,
    'back to the count the host asked for'
  );
});

test('successive polls see successive sweeps', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  const first = await request('GET', `${DEVICE_PATH}/trace`);
  const startedAt = Date.now();
  const second = await request('GET', `${DEVICE_PATH}/trace`);
  const elapsed = Date.now() - startedAt;

  assert.ok(second.body.sweepId > first.body.sweepId);
  // the long poll returns on the next sweep rather than after the hold cap
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for the next sweep`);
});

test('a reconfigure mid-sweep never yields a trace on the old grid', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });
  const before = await request('GET', `${DEVICE_PATH}/trace`);

  await request('POST', `${DEVICE_PATH}/configuration`, { pointCount: 101 });
  const after = await request(
    'GET',
    `${DEVICE_PATH}/trace?sinceSweepId=${before.body.sweepId}`
  );
  assert.equal(after.body.pointCount, 101);
  assert.equal(after.body.amplitudesDbm.length, 101);
});

test('max-hold keeps the peak of every sweep, including the transient', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
    traceMode: 'max-hold',
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
    await request('POST', `${DEVICE_PATH}/configuration`, {
      traceMode: 'clear-write',
    });
  });

  // ten consecutive sweeps always contain one of the every-seventh transients
  let trace = await request('GET', `${DEVICE_PATH}/trace`);
  const target = trace.body.sweepId + 10;
  const deadline = Date.now() + 5_000;
  while (trace.body.sweepId < target && Date.now() < deadline) {
    trace = await request('GET', `${DEVICE_PATH}/trace`);
  }

  assert.ok(
    trace.body.sweepId >= target,
    `only reached sweep ${trace.body.sweepId}`
  );
  const held = trace.body.amplitudesDbm[indexOf(TRANSIENT_HZ)];
  assert.ok(held >= -50, `transient never accumulated (peak ${held})`);
});

test('a simulated analyzer says so, where the user will see it', async () => {
  const device = await findDevice();
  const simulated = device.status.warnings?.find((w) => w.id === 'simulated');
  assert.ok(simulated, JSON.stringify(device.status));
  assert.equal(simulated.severity, 'info');
});

// The cable comes out: the worker dies with the device. That has to reach the
// host as a failed device with a message a person can act on — and the plugin
// has to be alive to say it.
test('a worker that dies mid-sweep marks the device failed, not healthy', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  await request('GET', `${DEVICE_PATH}/trace`);

  assert.equal(liveWorkers.size, 1, 'one worker per open device');
  for (const worker of liveWorkers) worker.child.kill('SIGKILL');

  const device = await waitForDevice((d) => d.status.status === 'failed');
  assert.equal(device.status.status, 'failed');
  assert.match(device.status.message, /USB cable/);

  const health = await request('GET', '/health');
  assert.equal(health.body.ok, true, 'the plugin itself is unaffected');
});

test('a failed device reopens on the next operation', async (t) => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
  });
  assert.equal(applied.status, 200);
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });
  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200);
  assert.equal((await findDevice()).status.status, 'ok');
});

// Addressing comes from the project, in device.config — the same project
// opened on another computer names the same analyzer.
test('a host-added device is addressed by the serial in its configuration', async (t) => {
  const id = 'foh-analyzer';
  t.after(() => request('DELETE', `/devices/${id}`));

  const wrong = await request('POST', '/devices', {
    id,
    product: PRODUCT,
    config: { serial: '12345' },
  });
  assert.equal(wrong.status, 201);
  const failed = await waitForDevice((d) => d.status.status === 'failed', id);
  assert.equal(failed.status.status, 'failed');
  assert.match(failed.status.message, /BB60 12345/);

  const right = await request('POST', '/devices', {
    id,
    product: PRODUCT,
    config: { serial: String(FAKE_SERIAL) },
  });
  assert.equal(right.status, 200);
  const ok = await waitForDevice((d) => d.status.status === 'ok', id);
  assert.equal(ok.status.status, 'ok');
});

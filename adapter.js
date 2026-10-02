// The Signal Hound BB60 as a SoundBase spectrum analyzer.
//
// This file is the contract-facing half: discovery, clamping, the effective
// configuration echo, warnings. It never touches USB. The analyzer is driven
// by a worker process — Signal Hound's library behind a JSON-lines pipe — that
// driver/bb60-driver.js owns and can kill; see docs/native-runtimes.md for why
// and driver/protocol.md for the wire.

import { Bb60Worker, listDevices } from './driver/bb60-driver.js';

// MUST be a `deviceTypeId` declared in soundbase-plugin.json — the host
// ignores a device naming a product the manifest never declared.
// `npm run rename` keeps the two in step; a test asserts they agree.
export const PRODUCT = 'plugin:signal-hound-bb60/bb60c';

// The vendor library's device types (BB_DEVICE_*) → the product we announce.
// Only the BB60C has been run against this plugin; a BB60A or BB60D is left
// out of discovery rather than announced as something it has not been proven
// to be.
const PRODUCT_BY_TYPE = { 2: PRODUCT };

const MIN_FREQUENCY_HZ = 9_000;
const MAX_FREQUENCY_HZ = 6_000_000_000;
// 200 kHz is the smallest span Signal Hound suggests sweeping
const MIN_SPAN_HZ = 200_000;
// 1 kHz is the floor on Apple Silicon: the ARM build of the vendor library
// refuses anything narrower in sweep mode
const RBW_HZ = [
  1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000, 3_000_000,
  10_000_000,
];
// What an automatic RBW resolves to. Narrow on purpose: every sweep is reduced
// to the host's points by peak, so a narrow RBW costs no coverage and a few
// milliseconds, and buys about 15 dB of noise floor over one sized to the
// point spacing — the difference between seeing a distant carrier and not.
const AUTO_RBW_HZ = 10_000;
// The device produces roughly 6.5 FFT bins per RBW across the whole span, and
// every one is fetched and reduced each sweep. Past a few million the sweep
// stops being live, so a narrow RBW on a wide span is widened instead.
const BINS_PER_RBW = 6.6;
const MAX_DEVICE_BINS = 4_000_000;

const DEFAULT_START_HZ = 470_000_000;
const DEFAULT_STOP_HZ = 616_000_000;
const DEFAULT_POINTS = 451;
const MAX_POINTS = 10_001;
// Automatic points: this many per RBW across the span, so adjacent points
// overlap and nothing the RBW can resolve falls between two of them.
const AUTO_POINTS_PER_RBW = 3;
// Every point crosses a pipe and an HTTP response, every sweep. This keeps a
// wide span at a narrow RBW live; past it the count is capped and echoed.
const MAX_AUTO_POINTS = 50_001;
// On unless the user turns it off: the trace then shows everything the RBW
// resolves, rather than whatever a typed point count happens to leave.
const DEFAULT_AUTO_POINTS = true;

const MIN_REF_LEVEL_DBM = -70;
const MAX_REF_LEVEL_DBM = 20;
const DEFAULT_REF_LEVEL_DBM = -20;
// Average first, so it is the default: mean power over the capture, which
// puts the noise floor where it really is. Peak holds the maximum instead,
// which catches a burst and lifts the floor by several dB doing it.
const DETECTORS = ['average', 'peak'];

// Video bandwidths. 1 kHz is the floor, as for RBW: the Apple Silicon library
// accepts a narrower one and ignores it.
const VBW_HZ = RBW_HZ;
const MIN_VBW_HZ = VBW_HZ[0];

// Dwell: how long the analyzer samples for one sweep, which is what steadies
// the trace — it averages every spectrum it captures in that time. The time
// needed for a given steadiness is inversely proportional to the RBW, so each
// dwell is a budget in milliseconds at 1 kHz RBW. Measured on a BB60C, 470-616
// MHz: `coordination` holds sweep-to-sweep noise to about 1 dB (from about 5),
// `hq` to about 0.5 dB, and `fast` does no averaging at all.
const DWELL_MS_AT_1KHZ = { fast: 0, coordination: 200, hq: 600 };
const DWELLS = Object.keys(DWELL_MS_AT_1KHZ);
const DEFAULT_DWELL = 'coordination';
const MIN_CAPTURE_MS = 1;
const MAX_CAPTURE_MS = 1_000;

const captureMsFor = (dwell, rbwHz) =>
  clamp(
    Math.round(DWELL_MS_AT_1KHZ[dwell] / (rbwHz / 1_000)),
    MIN_CAPTURE_MS,
    MAX_CAPTURE_MS
  );

const ADC_OVERFLOW = 2; // bbADCOverflow
const MIN_USB_VOLTS = 4.4; // below this, Signal Hound says readings are out of spec
const OVERLOAD_HOLD_MS = 3_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const nearestOf = (list, hz) =>
  list.reduce((best, candidate) =>
    Math.abs(candidate - hz) < Math.abs(best - hz) ? candidate : best
  );
const nearestRbw = (hz) => nearestOf(RBW_HZ, hz);

/** The narrowest listed RBW the device can sweep live across `spanHz`. */
const narrowestRbwFor = (spanHz) => {
  const floor = (spanHz * BINS_PER_RBW) / MAX_DEVICE_BINS;
  return RBW_HZ.find((rbw) => rbw >= floor) ?? RBW_HZ.at(-1);
};

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

let listing = null;

/**
 * BB60s attached right now. Called once a second while SoundBase enumerates —
 * including the whole time a device is sweeping — so it asks a short-lived
 * worker for the vendor library's device list and opens nothing. Listing is
 * safe beside an open, sweeping analyzer. No worker, no Signal Hound library,
 * nothing attached: all an empty list, never an error.
 */
export async function discoverDevices(pluginConfig) {
  // one listing at a time: a slow one must not stack up behind the cadence
  listing ??= listDevices(pluginConfig).finally(() => {
    listing = null;
  });
  const devices = await listing;
  return devices
    .filter((d) => PRODUCT_BY_TYPE[d.type])
    .map((d) => ({
      // The serial number is the analyzer's own identity: stable across
      // restarts, across USB ports, and across the computers a project moves
      // between.
      id: `usb:${d.serial}`,
      name: `${d.model} ${d.serial}`,
      product: PRODUCT_BY_TYPE[d.type],
      transport: { kind: 'usb', serial: String(d.serial) },
    }));
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new Bb60Adapter(device, pluginConfig);
}

/**
 * Which analyzer this device is. `device.config.serial` comes from the
 * project; a discovered device carries its serial in its id. Neither means
 * "the first BB60 attached", which is what a single-analyzer rig wants.
 */
function serialOf(device) {
  const fromConfig = Number(String(device.config?.serial ?? '').trim());
  if (Number.isInteger(fromConfig) && fromConfig > 0) return fromConfig;
  const match = /^usb:(\d+)$/.exec(device.id ?? '');
  return match ? Number(match[1]) : null;
}

class Bb60Adapter {
  constructor(device, pluginConfig) {
    this.pluginConfig = pluginConfig;
    this.serial = serialOf(device);
    this.worker = null;
    this.settings = null; // what was last applied, as the device took it
    this.generation = 0;
    this.sweeping = false;
    this.onTrace = null;
    this.failed = false;
    this.overloadedAt = 0;
    this.usbVolts = null;
    /** assigned by the shell */
    this.onFatal = null;
    this.onWarnings = null;
  }

  async open() {
    await this.close();
    this.failed = false;
    const worker = new Bb60Worker();
    worker.onFatal = (err) => this.#fail(err);
    // a sweep the device refuses mid-stream leaves nothing worth keeping open
    worker.onSweepError = (err) =>
      this.#fail(new Error(`The BB60 stopped sweeping: ${err.message}.`));
    worker.onTrace = (msg) => this.#onTrace(msg);
    worker.onDiagnostics = ({ usbVolts }) => {
      this.usbVolts = usbVolts;
      this.#reportWarnings();
    };
    // until open() has returned, a worker that dies is an open that failed —
    // reported by the throw below, not by onFatal as well
    this.failed = true;
    let identity;
    try {
      worker.start(this.pluginConfig);
      this.worker = worker;
      identity = await worker.open(this.serial);
      this.failed = false;
    } catch (err) {
      await this.close();
      // nothing to open it with: the message already says what to install
      if (err.setup || !worker.child) throw err;
      throw new Error(
        this.serial
          ? `Could not open BB60 ${this.serial}: ${err.message}. Check it is plugged into a USB 3 port and not in use by another application.`
          : `Could not open a BB60: ${err.message}. Check one is plugged into a USB 3 port and not in use by another application.`
      );
    }
    this.#reportWarnings();

    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        rbwHz: [...RBW_HZ],
        vbwHz: [...VBW_HZ],
        controls: [
          {
            id: 'refLevelDbm',
            type: 'number',
            label: 'Reference level',
            unit: 'dBm',
            default: DEFAULT_REF_LEVEL_DBM,
            min: MIN_REF_LEVEL_DBM,
            max: MAX_REF_LEVEL_DBM,
            step: 5,
            help: 'Raise it if the analyzer reports an overload.',
          },
          {
            id: 'dwell',
            type: 'dropdown',
            label: 'Dwell',
            default: DEFAULT_DWELL,
            choices: [
              { id: 'fast', label: 'Fast' },
              { id: 'coordination', label: 'Coordination' },
              { id: 'hq', label: 'High quality' },
            ],
            help: 'Longer is steadier and slower.',
          },
          {
            id: 'detector',
            type: 'dropdown',
            label: 'Detector',
            default: DETECTORS[0],
            choices: [
              { id: 'average', label: 'RMS average' },
              { id: 'peak', label: 'Positive peak' },
            ],
          },
          {
            id: 'autoPoints',
            type: 'checkbox',
            label: 'Auto points',
            default: DEFAULT_AUTO_POINTS,
            help: `${AUTO_POINTS_PER_RBW} per RBW. Overrides the point count.`,
          },
        ],
      },
      identity: {
        manufacturer: 'Signal Hound',
        model: identity.model,
        firmware: String(identity.firmware),
        serial: String(identity.serial),
      },
    };
  }

  /**
   * Clamp what was asked for to what a BB60 sweeps, apply it, and echo what
   * the device took. `cfg` is the host's whole desired state: an absent
   * `rbwHz` means automatic, and `controls` arrives merged by id.
   */
  async applyConfig(cfg = {}) {
    const previous = this.settings ?? {};
    let startHz = isNum(cfg.startHz)
      ? cfg.startHz
      : (previous.startHz ?? DEFAULT_START_HZ);
    let stopHz = isNum(cfg.stopHz)
      ? cfg.stopHz
      : (previous.stopHz ?? DEFAULT_STOP_HZ);
    startHz = clamp(startHz, MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ - MIN_SPAN_HZ);
    stopHz = clamp(stopHz, startHz + MIN_SPAN_HZ, MAX_FREQUENCY_HZ);
    const spanHz = stopHz - startHz;

    const explicitRbw = isNum(cfg.rbwHz);
    const rbwHz = Math.max(
      explicitRbw ? nearestRbw(cfg.rbwHz) : AUTO_RBW_HZ,
      narrowestRbwFor(spanHz)
    );

    const controls = cfg.controls ?? {};
    const autoPoints =
      typeof controls.autoPoints === 'boolean'
        ? controls.autoPoints
        : (previous.autoPoints ?? DEFAULT_AUTO_POINTS);
    // the count the user typed is kept while automatic is on, so switching
    // back returns to it rather than to whatever automatic last worked out
    const manualPoints = clamp(
      Math.round(
        isNum(cfg.pointCount)
          ? cfg.pointCount
          : (previous.manualPoints ?? DEFAULT_POINTS)
      ),
      2,
      MAX_POINTS
    );
    const pointCount = autoPoints
      ? clamp(
          Math.round((spanHz / rbwHz) * AUTO_POINTS_PER_RBW) + 1,
          2,
          MAX_AUTO_POINTS
        )
      : manualPoints;
    const refLevelDbm = isNum(Number(controls.refLevelDbm ?? NaN))
      ? clamp(
          Math.round(Number(controls.refLevelDbm)),
          MIN_REF_LEVEL_DBM,
          MAX_REF_LEVEL_DBM
        )
      : (previous.refLevelDbm ?? DEFAULT_REF_LEVEL_DBM);
    const detector = DETECTORS.includes(controls.detector)
      ? controls.detector
      : (previous.detector ?? DETECTORS[0]);
    const dwell = DWELLS.includes(controls.dwell)
      ? controls.dwell
      : (previous.dwell ?? DEFAULT_DWELL);

    // An automatic VBW is a tenth of the RBW — the usual ratio, and the one
    // thing that steadies a span too wide for the capture time to matter —
    // except at the fast dwell, which asks for no averaging of any kind.
    const explicitVbw = isNum(cfg.vbwHz);
    const vbwHz = clamp(
      explicitVbw
        ? nearestOf(VBW_HZ, cfg.vbwHz)
        : dwell === 'fast'
          ? rbwHz
          : rbwHz / 10,
      MIN_VBW_HZ,
      rbwHz
    );

    const applied = await this.#worker().configure({
      startHz,
      stopHz,
      pointCount,
      rbwHz,
      vbwHz,
      captureMs: captureMsFor(dwell, rbwHz),
      refLevelDbm,
      detector,
    });
    this.generation = applied.gen;
    this.settings = {
      startHz: applied.startHz,
      stopHz: applied.stopHz,
      pointCount: applied.pointCount,
      manualPoints,
      autoPoints,
      refLevelDbm: applied.refLevelDbm,
      detector: applied.detector,
      dwell,
    };
    // the reference level changed what counts as an overload
    this.overloadedAt = 0;
    this.#reportWarnings();

    const resolved = { sweepTimeMs: Math.ceil(applied.sweepMs) };
    // An automatic RBW is reported as what auto resolved to, so the user's
    // field keeps showing "auto"; an explicit one as what the device took.
    if (!explicitRbw) resolved.rbwHz = applied.rbwHz;
    // The VBW in force, always: the shell echoes the one that was asked for,
    // and this is where the host learns what it was clamped or resolved to.
    resolved.vbwHz = applied.vbwHz;
    return {
      startHz: applied.startHz,
      stopHz: applied.stopHz,
      pointCount: applied.pointCount,
      ...(explicitRbw ? { rbwHz: applied.rbwHz } : {}),
      controls: {
        refLevelDbm: applied.refLevelDbm,
        detector: applied.detector,
        dwell,
        autoPoints,
      },
      resolved,
    };
  }

  async startSweep(onTrace) {
    this.onTrace = onTrace;
    if (this.sweeping) return;
    await this.#worker().startSweep();
    this.sweeping = true;
  }

  async stopSweep() {
    if (!this.sweeping) return;
    this.sweeping = false;
    await this.worker?.stopSweep().catch(() => {});
  }

  /** Release the analyzer: the worker exits, and the device with it. */
  async close() {
    this.sweeping = false;
    const worker = this.worker;
    this.worker = null;
    await worker?.close();
  }

  #worker() {
    if (!this.worker) throw new Error('The BB60 is not open.');
    return this.worker;
  }

  #onTrace({ gen, status, amps }) {
    // a sweep from before the last applyConfig is on the wrong grid
    if (!this.sweeping || gen !== this.generation) return;
    if (amps.length !== this.settings?.pointCount) return;
    if (status === ADC_OVERFLOW) this.overloadedAt = Date.now();
    this.#reportWarnings();
    this.onTrace?.(amps);
  }

  /** The complete current set, every time; the shell drops repeats. */
  #reportWarnings() {
    const warnings = [];
    if (Date.now() - this.overloadedAt < OVERLOAD_HOLD_MS) {
      warnings.push({
        id: 'overload',
        severity: 'warning',
        message:
          'Input overload: a signal is stronger than the reference level, so the trace is distorted. Raise the reference level, or add attenuation at the antenna input.',
      });
    }
    if (isNum(this.usbVolts) && this.usbVolts < MIN_USB_VOLTS) {
      warnings.push({
        id: 'usb-voltage',
        severity: 'warning',
        message: `USB supply is low (${this.usbVolts.toFixed(2)} V), so levels may be out of specification. Use a shorter or better cable, or a powered USB 3 port.`,
      });
    }
    if (this.worker?.mock) {
      warnings.push({
        id: 'simulated',
        severity: 'info',
        message:
          'This is a simulated BB60. The spectrum shown is synthetic, not a measurement.',
      });
    }
    this.onWarnings?.(warnings);
  }

  #fail(err) {
    if (this.failed) return;
    this.failed = true;
    this.sweeping = false;
    this.onFatal?.(err);
  }
}

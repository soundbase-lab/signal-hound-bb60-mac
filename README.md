# Signal Hound BB60 for SoundBase

A SoundBase plugin that makes a Signal Hound BB60 spectrum analyzer a live scan
source on a Mac. Its sweeps become the live trace on the plot, and the levels
it measures decide which frequencies SoundBase is willing to coordinate.

## What you need

- **An Apple Silicon Mac.** Signal Hound ships its BB60 library for macOS on
  Apple Silicon only, so this plugin does not run on Intel Macs or Windows.
- **A BB60C on a USB 3 port.** It needs no driver and no administrator rights.
- **Two things installed once per Mac**, below. Until they are, the plugin
  runs but finds no analyzer.

## Setup

The plugin drives the analyzer through Signal Hound's own BB60 library. That
library is Signal Hound's software, under Signal Hound's licence, so it is not
included with the plugin: you install it from Signal Hound. It in turn needs
libusb.

### The quick way

In Terminal, run the script in the plugin folder:

```sh
./install-signal-hound-library.sh
```

It installs libusb with [Homebrew](https://brew.sh) if it is missing, downloads
the Signal Hound SDK from signalhound.com (about 160 MB), and copies the one
file the plugin needs to
`~/Library/Application Support/signal-hound-bb60/`. It needs no administrator
password, and running it again is harmless. If you already have the SDK zip,
pass it and nothing is downloaded:

```sh
./install-signal-hound-library.sh ~/Downloads/signal_hound_sdk_09_14_26.zip
```

### By hand

1. Install libusb:

   ```sh
   brew install libusb
   ```

2. Download the **Signal Hound SDK** from
   [signalhound.com](https://signalhound.com/software/signal-hound-software-development-kit-sdk/)
   and unzip it.
3. Copy `signal_hound_sdk/device_apis/bb_series/lib/macos_arm/libbb_api.5.0.11.dylib`
   into `~/Library/Application Support/signal-hound-bb60/` (create the folder).
   `/usr/local/lib` and `/opt/homebrew/lib` are searched too.
4. Because the file came through a browser, macOS quarantines it. Clear that:

   ```sh
   xattr -d com.apple.quarantine ~/Library/Application\ Support/signal-hound-bb60/libbb_api.5.0.11.dylib
   ```

If the library has to live somewhere else, put its path in the plugin's
**Signal Hound library** setting in SoundBase.

The plugin was tested with BB60 API 5.0.11, from the SDK dated 14 September
2026. It needs 5.0.11 or later: earlier versions have no macOS build.

### If no analyzer appears

The plugin log in SoundBase says which of the two is missing. Running the
script again also checks: it ends by reporting the analyzer it found.

## What it does, and does not

| | |
|---|---|
| Models | **BB60C**, tested on firmware 7. A BB60A or BB60D is not offered: neither has been run against this plugin. |
| Range | 9 kHz – 6 GHz |
| RBW | 1 kHz – 10 MHz. 1 kHz is the narrowest the Apple Silicon library sweeps. An RBW too narrow for the span is widened, and SoundBase shows what was used. |
| Automatic RBW | 10 kHz |
| VBW | 1 kHz up to the RBW; automatic is a tenth of the RBW. 1 kHz is the narrowest the Apple Silicon library applies. |
| Dwell | How long the analyzer samples per sweep: Fast, Coordination (default) or High quality. See below. |
| Detector | RMS average (default) or positive peak |
| Reference level | −70 to +20 dBm, default −20 |
| Automatic points | On by default: the point count is 3 per RBW across the span (span ÷ RBW × 3), up to 50,000, and the typed point count is ignored. Turn it off to set the point count yourself. |
| Warnings | Input overload, low USB supply voltage |

### A steady trace

A single spectrum from the analyzer is noisy: about 5 dB of sweep-to-sweep
movement on the noise floor. The plugin steadies it the way a bench analyzer
does, by having the BB60 average many spectra into each sweep:

- **Dwell** sets how long it samples. A narrow RBW needs a longer sample for
  the same steadiness, so a given dwell is a slower sweep at a narrower RBW.
- **VBW** narrower than the RBW does the same job, and is what steadies a span
  too wide for the dwell to matter.
- **RMS average** shows the mean power, which puts the noise floor where it
  really is. **Positive peak** holds the strongest reading during the dwell
  instead: it catches short bursts, and shows the floor a few dB high.

Measured on a BB60C, 470–616 MHz, RMS average:

| RBW | Fast | Coordination | High quality |
|---|---|---|---|
| 10 kHz | 21 ms per sweep, 4.5 dB of noise | 46 ms, 0.7 dB | 82 ms, 0.5 dB |
| 3 kHz | 31 ms, 3.2 dB | 84 ms, 0.8 dB | 231 ms, 0.4 dB |
| 1 kHz | 81 ms, 2.1 dB | 235 ms, 0.6 dB | 927 ms, 0.3 dB |

For a faster trace, choose Fast; for a transient you must not miss, choose
positive peak, or use SoundBase's max-hold trace mode.

The analyzer produces far more points than SoundBase draws at a typed point
count — about 60,000 for a UHF sweep at 10 kHz. Each sweep is reduced to the
points in use by taking the **strongest** reading in each, with either
detector, so a carrier narrower than a point on the plot is never lost.

Only one program can use a BB60 at a time. Close Spike, or anything else
holding the analyzer, before sweeping from SoundBase.

## Developing

```sh
npm install
npm run build:worker   # compiles the worker; needs only Xcode's command line tools
npm run doctor
npm test
npm run smoke          # boots as SoundBase does; sweeps a BB60 if one is attached
```

To sweep a real analyzer, do the [setup](#setup) above as a user would.

No analyzer is needed for any of it. `npm test` runs the adapter under the real
plugin shell against a fake worker, on any platform, and the native worker
against its own synthetic device on Apple Silicon. To poke at a running plugin
with nothing attached:

```sh
SB_BB60_MOCK=1 npm start
```

### How it is put together

```
adapter.js                  contract-facing: discovery, clamping, the config echo, warnings
driver/
  bb60-driver.js            owns one worker process per open analyzer
  protocol.md               the JSON-lines protocol between them
  fake-worker.mjs           the same protocol with a synthetic spectrum, for tests
  worker/bb60_worker.cpp    the only code that calls Signal Hound's library
  worker/bin/               built: the worker (not in git)
scripts/build-worker.mjs    builds worker/bin/
install-signal-hound-library.sh   the user's one-time setup; ships in the release
```

The worker does not link Signal Hound's library; it loads the user's installed
copy at run time. So nothing of Signal Hound's is needed to build or test, and
nothing of theirs is in this repository or in a release.

The Signal Hound library runs in a separate worker process rather than inside
the plugin, so a USB call that never returns costs one killed worker and a
clear device error instead of the whole plugin. `docs/native-runtimes.md`
explains the pattern; `CLAUDE.md` lists what is specific to the BB60.

## Releasing

`.github/workflows/release.yml` builds the worker on an Apple Silicon runner
and packs it into the release zip; `docs/publishing.md` covers the rest. By
hand, `npm run build:worker && npm run pack:release` produces the same zip.

The zip contains no Signal Hound software, and the pack step refuses to build
one that does.

## Licence

The plugin is under the Business Source License 1.1 — see `LICENSE`. The Signal
Hound API library is Signal Hound's, under its own terms, and is obtained from
Signal Hound by each user.

# Worker protocol

`driver/bb60-driver.js` talks to one worker process per open device over
stdio: one JSON object per line, each way. Two programs speak it — the native
`worker/bb60_worker.cpp`, and `fake-worker.mjs`, which the tests run with
nothing attached.

## Requests → replies

Every request carries an `id`; the reply echoes it with `ok: true` plus
fields, or `ok: false` with `error` (a sentence) and `status` (the vendor's
`bbStatus`, 0 when it is ours).

| `op` | request fields | reply fields |
|---|---|---|
| `list` | | `devices: [{ serial, type, model }]` |
| `open` | `serial?` — absent opens the first device | `serial, type, model, firmware, apiVersion` |
| `config` | any of `startHz, stopHz, pointCount, rbwHz, vbwHz, captureMs, refLevelDbm, detector` | what is in force: all of those, plus `gen, deviceBins, binHz, sweepMs` |
| `start` | | |
| `stop` | | |
| `quit` | | the worker then exits |

`config` is a patch: absent fields keep their value. The reply's `rbwHz` can
be wider than the request when the device refuses that bandwidth at that span.
`vbwHz` comes back clamped to between 1 kHz and the RBW, and `captureMs` (how
long the device samples per sweep) to 1–1000. `detector` is `average` or
`peak`. `sweepMs` is one real sweep, timed, at the new settings.

`bb60-worker --list` prints the `list` reply's fields as one line and exits,
without opening anything. It is safe while another worker is sweeping.

The native worker takes `--lib <path>`: Signal Hound's library, which it loads
at run time. When that fails, `list` answers `devices: []` with a
`libraryError`, and `open` answers `ok: false` with `error: "library"` and the
same `libraryError` — the loader's own words, which the driver turns into
setup instructions. `--mock` needs no library.

## Events

| `ev` | fields | |
|---|---|---|
| `trace` | `gen, status, amps` | one completed sweep: `pointCount` values in dBm, already on the host's grid. `gen` is the `config` it was swept under; `status` is a `bbStatus` warning (2 = ADC overflow) or 0 |
| `diag` | `tempC, usbVolts` | about every two seconds while sweeping |
| `error` | `status, error` | a sweep failed and sweeping stopped; the device is still open |
| `fatal` | `status, error` | the transport is gone; the worker exits |

## Closing

There is no `close`. The macOS build of the vendor library crashes in
`bbCloseDevice`, so a device is released by the worker exiting: `quit`, stdin
closing, or SIGKILL from the driver when a request does not answer.

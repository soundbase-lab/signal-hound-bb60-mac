#!/usr/bin/env node
// Build driver/worker/bin/bb60-worker — the native half of this plugin.
//
//   node scripts/build-worker.mjs
//
// It needs a C++ compiler and nothing else. Signal Hound's library is not
// linked: the worker loads it at run time from wherever the user installed it
// (see README, "Setup"), so nothing of theirs is needed to build, and nothing
// of theirs ends up in driver/worker/bin/ or in a release zip.
//
// bin/ is gitignored; scripts/pack-release.mjs carries it into the release.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKER = join(ROOT, 'driver', 'worker');
const BIN = join(WORKER, 'bin');

const log = (msg) => process.stdout.write(`[build-worker] ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[build-worker] ERROR: ${msg}\n`);
  process.exit(1);
};
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error || r.status !== 0) fail(`${cmd} ${args.join(' ')} failed`);
};

// The vendor library exists for Apple Silicon only, so there is nothing worth
// building anywhere else — and a CI matrix that includes other targets should
// not fail for it. The JavaScript tests run everywhere against the fake worker.
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  log(
    `nothing to build on ${process.platform}-${process.arch}: Signal Hound ` +
      'ships the BB60 API for macOS on Apple Silicon only'
  );
  process.exit(0);
}

rmSync(BIN, { recursive: true, force: true });
mkdirSync(BIN, { recursive: true });
const worker = join(BIN, 'bb60-worker');

run('clang++', [
  '-std=c++17',
  '-O2',
  '-Wall',
  '-arch',
  'arm64',
  '-mmacosx-version-min=13.0',
  join(WORKER, 'bb60_worker.cpp'),
  '-o',
  worker,
]);
chmodSync(worker, 0o755);

// Prove it starts, here, before a user finds out it does not.
const probe = spawnSync(worker, ['--mock', '--list'], { encoding: 'utf8' });
if (probe.status !== 0 || !probe.stdout.includes('"devices"')) {
  fail(`the worker does not start: ${probe.stderr?.trim() || probe.error}`);
}
log(`built ${worker}`);

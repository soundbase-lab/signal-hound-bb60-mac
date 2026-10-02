// Finding Signal Hound's library. It is the user's to install, so where it is
// differs from Mac to Mac; these pin down the order the plugin looks in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLibrary } from '../driver/bb60-driver.js';

const folderWith = (...names) => {
  const dir = mkdtempSync(join(tmpdir(), 'bb60-lib-'));
  for (const name of names) writeFileSync(join(dir, name), '');
  return dir;
};

test('a file named in the plugin setting is used as it is', () => {
  const file = join(folderWith('anything.dylib'), 'anything.dylib');
  assert.equal(findLibrary({ libraryPath: ` ${file} ` }, {}), file);
});

test('a folder is searched for the library, newest version first', () => {
  const dir = folderWith(
    'libbb_api.5.0.11.dylib',
    'libbb_api.5.0.12.dylib',
    'libusb-1.0.0.dylib',
    'notes.txt'
  );
  assert.equal(
    findLibrary({ libraryPath: dir }, {}),
    join(dir, 'libbb_api.5.0.12.dylib')
  );
});

test('the plugin setting wins over the environment', () => {
  const setting = folderWith('libbb_api.5.dylib');
  const env = folderWith('libbb_api.5.dylib');
  assert.equal(
    findLibrary({ libraryPath: setting }, { SB_BB60_LIBRARY: env }),
    join(setting, 'libbb_api.5.dylib')
  );
  assert.equal(
    findLibrary({}, { SB_BB60_LIBRARY: env }),
    join(env, 'libbb_api.5.dylib')
  );
});

test('a setting that points at nothing falls through rather than failing', () => {
  const env = folderWith('libbb_api.5.dylib');
  assert.equal(
    findLibrary({ libraryPath: '/nonexistent' }, { SB_BB60_LIBRARY: env }),
    join(env, 'libbb_api.5.dylib')
  );
});

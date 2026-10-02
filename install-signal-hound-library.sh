#!/bin/bash
# One-time setup for the Signal Hound BB60 plugin on this Mac.
#
#   ./install-signal-hound-library.sh                 download the SDK from Signal Hound
#   ./install-signal-hound-library.sh <sdk.zip>       use an SDK zip you already downloaded
#   ./install-signal-hound-library.sh <libbb_api…dylib>   use the library file itself
#
# The plugin drives the analyzer through Signal Hound's own BB60 API library.
# That library is Signal Hound's, under Signal Hound's licence, so it is not
# part of this plugin: this script fetches it for you, from signalhound.com,
# and puts the one file the plugin needs where the plugin looks for it. It
# also installs libusb, which that library needs.
#
# Nothing here needs administrator rights, and running it twice is harmless.

set -euo pipefail

SDK_URL="https://signalhound.com/sigdownloads/SDK/signal_hound_sdk_09_14_26.zip"
SDK_SHA256="af15c2b2f53196653056bf7b6a3a932794c5b91e46923ccfeb005c65dcee2e93"
SDK_PAGE="https://signalhound.com/software/signal-hound-software-development-kit-sdk/"
LIBRARY_IN_SDK="device_apis/bb_series/lib/macos_arm/"
LICENSE_IN_SDK="signal_hound_sdk/device_apis/LICENSE.rtf"

DEST="$HOME/Library/Application Support/signal-hound-bb60"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORKER="$HERE/driver/worker/bin/bb60-worker"

say() { printf '%s\n' "$*"; }
die() { printf '\nSetup did not finish: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] ||
  die "Signal Hound provides the BB60 library for Macs with Apple Silicon only."

# -- libusb ---------------------------------------------------------------------
# Signal Hound's library loads libusb from Homebrew's location, by full path.

LIBUSB="/opt/homebrew/opt/libusb/lib/libusb-1.0.0.dylib"
if [ -e "$LIBUSB" ]; then
  say "libusb: already installed"
else
  BREW="$(command -v brew || true)"
  [ -n "$BREW" ] || [ ! -x /opt/homebrew/bin/brew ] || BREW=/opt/homebrew/bin/brew
  [ -n "$BREW" ] ||
    die "libusb is needed, and it comes from Homebrew, which is not installed. Install Homebrew from https://brew.sh, then run this again."
  say "libusb: installing with Homebrew"
  "$BREW" install libusb
  [ -e "$LIBUSB" ] || die "Homebrew ran, but $LIBUSB is still missing."
fi

# -- the Signal Hound library ---------------------------------------------------

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SOURCE="${1:-}"
ZIP=""
LIBRARY=""

case "$SOURCE" in
  "")
    ZIP="$WORK/signal_hound_sdk.zip"
    say "Signal Hound SDK: downloading from signalhound.com (about 160 MB)"
    curl -fL --retry 3 --progress-bar -o "$ZIP" "$SDK_URL" ||
      die "the download failed. Signal Hound may have published a newer SDK: download it from $SDK_PAGE and run this again with the zip, e.g.  $0 ~/Downloads/signal_hound_sdk.zip"
    # The pinned release is the one this plugin was tested with. A different
    # file at the same address is worth knowing about, not worth refusing.
    [ "$(shasum -a 256 "$ZIP" | cut -d' ' -f1)" = "$SDK_SHA256" ] ||
      say "note: this is not the SDK release the plugin was tested with (14 September 2026); continuing."
    ;;
  *.zip) [ -f "$SOURCE" ] || die "there is no file at $SOURCE"; ZIP="$SOURCE" ;;
  *.dylib) [ -f "$SOURCE" ] || die "there is no file at $SOURCE"; LIBRARY="$SOURCE" ;;
  *) die "expected an SDK .zip or a libbb_api .dylib, got: $SOURCE" ;;
esac

if [ -n "$ZIP" ]; then
  ENTRY="$(unzip -Z1 "$ZIP" | grep -F "$LIBRARY_IN_SDK" | grep -E '/libbb_api[^/]*\.dylib$' | sort | tail -1 || true)"
  [ -n "$ENTRY" ] ||
    die "this SDK has no BB60 library for macOS in it (looked for $LIBRARY_IN_SDK)."
  unzip -q -j -o "$ZIP" "$ENTRY" -d "$WORK/lib"
  unzip -q -j -o "$ZIP" "$LICENSE_IN_SDK" -d "$WORK/lib" 2>/dev/null || true
  LIBRARY="$WORK/lib/$(basename "$ENTRY")"
fi

file "$LIBRARY" | grep -q "arm64" ||
  die "$(basename "$LIBRARY") is not an Apple Silicon library."

mkdir -p "$DEST"
rm -f "$DEST"/libbb_api*.dylib
cp "$LIBRARY" "$DEST/"
[ ! -f "$WORK/lib/LICENSE.rtf" ] || cp "$WORK/lib/LICENSE.rtf" "$DEST/SIGNAL-HOUND-LICENSE.rtf"
INSTALLED="$DEST/$(basename "$LIBRARY")"
# a file that came through a browser is quarantined, and will not load
xattr -d com.apple.quarantine "$INSTALLED" 2>/dev/null || true
say "Signal Hound library: installed at $INSTALLED"
[ ! -f "$DEST/SIGNAL-HOUND-LICENSE.rtf" ] ||
  say "  It is Signal Hound's software; its licence is beside it, in SIGNAL-HOUND-LICENSE.rtf."

# -- check ------------------------------------------------------------------------

if [ -x "$WORKER" ]; then
  RESULT="$("$WORKER" --lib "$INSTALLED" --list 2>/dev/null || true)"
  case "$RESULT" in
    *libraryError*) die "the library is in place but does not load: $RESULT" ;;
    *'"serial"'*) say "Analyzer found: $RESULT" ;;
    *) say "No BB60 is plugged in right now; the plugin will find one when it is." ;;
  esac
fi

say ""
say "Done. Open SoundBase's live scan settings and the BB60 will be listed."

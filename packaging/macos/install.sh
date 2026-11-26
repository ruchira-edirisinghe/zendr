#!/bin/sh
# Installs Zendr for the current Mac user. No admin rights needed.
#
#   Double-click won't run it: open Terminal in this folder and run  ./install.sh
#
# Puts herdr-core (the background core that keeps your terminals running) in ~/.local/bin,
# Zendr.app in ~/Applications, and Zendr's mods, layout and add-ons in ~/.config/herdr-app.
# Running it again updates everything; running terminals keep running.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
say() { printf '%s\n' "$*"; }
fail() { say "zendr: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this is the macOS build"
case "$(uname -m)" in
  arm64) machine=arm64 ;;
  x86_64) machine=x64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
package=$(cat "$here/arch.txt" 2>/dev/null || echo "$machine")
if [ "$package" = x64 ] && [ "$machine" = arm64 ]; then
  say "This is the Intel build; on this Mac it runs under Rosetta. Zendr-...-macos-arm64 runs natively."
elif [ "$package" = arm64 ] && [ "$machine" = x64 ]; then
  fail "this is the Apple silicon build. Download Zendr-...-macos-x64 for this Mac."
fi

say ""
say "  Installing Zendr ($package)"
say ""

# Downloads carry a quarantine flag; the builds are signed ad hoc, not by Apple, so clear it
# or macOS refuses to open them.
xattr -dr com.apple.quarantine "$here" 2>/dev/null || true

# 1. The core. One that's running is swapped the planned way: its terminals keep running.
bin="$HOME/.local/bin"
mkdir -p "$bin"
if [ -x "$bin/herdr-core" ] && "$bin/herdr-core" --version >/dev/null 2>&1; then
  "$bin/herdr-core" update --from "$here/core/herdr-core" --force >/dev/null || fail "updating $bin/herdr-core failed"
  say "core    updated in $bin/herdr-core"
else
  cp "$here/core/herdr-core" "$bin/herdr-core.new"
  chmod 755 "$bin/herdr-core.new"
  mv -f "$bin/herdr-core.new" "$bin/herdr-core"
  say "core    installed in $bin/herdr-core"
fi
if ! command -v hc >/dev/null 2>&1 && [ ! -e "$bin/hc" ]; then ln -s herdr-core "$bin/hc"; fi

# 2. The app.
apps="$HOME/Applications"
mkdir -p "$apps"
rm -rf "$apps/Zendr.app.new"
cp -R "$here/Zendr.app" "$apps/Zendr.app.new"
rm -rf "$apps/Zendr.app"
mv "$apps/Zendr.app.new" "$apps/Zendr.app"
xattr -dr com.apple.quarantine "$apps/Zendr.app" 2>/dev/null || true
say "app     $apps/Zendr.app"
# `zendr` on the command line: the app's CLI (zendr do / ls / status ...).
ln -sf "$apps/Zendr.app/Contents/MacOS/Zendr" "$bin/zendr"

# 3. Zendr's mods, layout and add-ons (mods with the same names are replaced; yours stay).
config="$HOME/.config/herdr-app"
mkdir -p "$config/mods" "$config/layouts"
for mod in "$here"/config/mods/*/; do
  name=$(basename "$mod")
  rm -rf "$config/mods/$name"
  cp -R "$mod" "$config/mods/$name"
done
say "mods    $(ls -d "$here"/config/mods/*/ | wc -l | tr -d ' ')"
cp "$here/config/layouts/main-review.json" "$config/layouts/main-review.json"
rm -rf "$config/addons"
cp -R "$here/config/addons" "$config/addons"
say "addons  $(ls -d "$config"/addons/*/ | wc -l | tr -d ' ') (all off until you turn them on in Settings)"

# Zendr's shortcuts are added to keys.json, keeping every binding already there; and its
# layout is the one shown, unless you picked another. (JavaScript for Automation: every
# Mac has it, unlike python3.)
/usr/bin/osascript -l JavaScript - "$config" "$here/config/keys.json" <<'JS' >/dev/null
function run(argv) {
  ObjC.import("Foundation");
  const read = (p) => {
    const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
    return s.isNil() ? null : JSON.parse(s.js);
  };
  const write = (p, v) => $(JSON.stringify(v, null, 2) + "\n").writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null);
  const config = argv[0];
  const keys = read(config + "/keys.json") || {};
  const add = read(argv[1]) || {};
  for (const section of Object.keys(add)) {
    keys[section] = keys[section] || {};
    for (const k of Object.keys(add[section])) if (!(k in keys[section])) keys[section][k] = add[section][k];
  }
  write(config + "/keys.json", keys);
  const shared = read(config + "/shared.json") || {};
  if (!shared.layout) { shared.layout = "main-review"; write(config + "/shared.json", shared); }
}
JS
say "keys    merged into $config/keys.json"

# An open Zendr switches to the layout now; a closed one starts on it.
"$bin/zendr" do layout.switch '{"name":"main-review"}' >/dev/null 2>&1 || true

say ""
say "  Zendr is ready: open it from Applications (or Spotlight), or type zendr in a new terminal."
case ":$PATH:" in *":$bin:"*) ;; *) say "  (Add $bin to your PATH for the zendr and hc commands.)" ;; esac
say ""
[ "${1:-}" = "--no-launch" ] || open "$apps/Zendr.app"

#!/bin/bash
# Builds Zendr on a Mac for its own CPU and packs dist/Zendr-<version>-macos-<arm64|x64>.tar.gz:
# Zendr.app, herdr-core, Zendr's mods and layout, and install.sh (packaging/macos/install.sh).
# Needs Rust, Zig 0.16 and the Xcode command line tools. CI runs it (.github/workflows/macos.yml).
#
#   packaging/macos/package.sh
#
# The app and core are signed ad hoc (no Apple Developer ID): install.sh clears the download
# quarantine, so macOS opens it without the "unidentified developer" stop.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "package: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

git submodule update --init --depth 1 app/vendor/ghostty core/vendor/ghostty
# A source build never updates itself to Herdr's releases (app/src/update.rs).
unset HERDR_APP_RELEASE
(cd core && cargo build --release --locked)
(cd app && cargo build --release --locked)

version=$(sed -n 's/^version = "\(.*\)"/\1/p' app/Cargo.toml | head -1)
name="Zendr-$version-macos-$arch"
stage="dist/$name"
rm -rf "$stage" "dist/$name.tar.gz"
mkdir -p "$stage/core"

# Zendr.app
app="$stage/Zendr.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp app/target/release/herdr-app "$app/Contents/MacOS/Zendr"
cp app/LICENSE app/THIRD-PARTY-NOTICES "$app/Contents/Resources/"
icons=$(mktemp -d)/Zendr.iconset
mkdir -p "$icons"
for s in 16 32 128 256 512; do
  sips -z $s $s app/assets/icons/herdr-ui-icon-clean.png --out "$icons/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) app/assets/icons/herdr-ui-icon-clean.png --out "$icons/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$icons" -o "$app/Contents/Resources/Zendr.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>Zendr</string>
    <key>CFBundleIdentifier</key><string>dev.zendr.app</string>
    <key>CFBundleName</key><string>Zendr</string>
    <key>CFBundleDisplayName</key><string>Zendr</string>
    <key>CFBundleIconFile</key><string>Zendr</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$version</string>
    <key>CFBundleVersion</key><string>$version</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSMicrophoneUsageDescription</key><string>Terminal programs running in Zendr can use the microphone, for example for voice input.</string>
    <key>NSCameraUsageDescription</key><string>Terminal programs running in Zendr can use the camera.</string>
    <key>NSAppleEventsUsageDescription</key><string>Terminal programs running in Zendr can use AppleScript to control other apps.</string>
    <key>NSLocalNetworkUsageDescription</key><string>Zendr answers the Zendr phone app on your local network when you allow it in Settings, Phone.</string>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSEnvironment</key><dict/></dict></plist>
PLIST
codesign --force --deep --sign - "$app"

# The core, the config and the installer.
cp core/target/release/herdr-core "$stage/core/herdr-core"
codesign --force --sign - "$stage/core/herdr-core"
cp -R config "$stage/config"
cp packaging/macos/install.sh "$stage/install.sh"
chmod 755 "$stage/install.sh" "$stage/core/herdr-core"
cp LICENSE NOTICE "$stage/"
echo "$arch" > "$stage/arch.txt"

# Smoke test: both binaries start and say their version.
"$stage/core/herdr-core" --version
"$app/Contents/MacOS/Zendr" --version

tar -czf "dist/$name.tar.gz" -C dist "$name"
(cd dist && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")
echo "Packed dist/$name.tar.gz"
cat "dist/$name.tar.gz.sha256"

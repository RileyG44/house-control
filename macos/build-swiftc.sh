#!/bin/bash
# Builds the House Control Mac binary with swiftc directly, for a Mac where `swift build` is
# broken (Command Line Tools without SWBBuildService). Output: /tmp/hcbuild/HouseControl.
set -e
cd "$(dirname "$0")/.."
B=/tmp/hcbuild
rm -rf $B; mkdir -p $B
T=(-target arm64-apple-macos13.0 -swift-version 5 -O -wmo)
swiftc "${T[@]}" -parse-as-library -module-name HouseCore -emit-module -emit-module-path $B/HouseCore.swiftmodule \
  -emit-library -static -o $B/libHouseCore.a core/Sources/HouseCore/*.swift
echo "core ok"
swiftc "${T[@]}" -parse-as-library -module-name HouseSmartLife -I $B -emit-module -emit-module-path $B/HouseSmartLife.swiftmodule \
  -emit-library -static -o $B/libHouseSmartLife.a core/Sources/HouseSmartLife/*.swift
echo "smartlife ok"
swiftc "${T[@]}" -module-name HouseControl -I $B -L $B -lHouseCore -lHouseSmartLife macos/Sources/HouseControl/*.swift -o $B/HouseControl
echo "app ok"
ls -la $B/HouseControl

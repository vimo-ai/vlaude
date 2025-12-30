#!/usr/bin/env bash
# ============================================================================
# 更新 VlaudeKit Plugin 中的 session_reader_ffi
# 编译 session-reader-ffi 并复制到 VlaudeKit/Libs
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_LIB_DIR="/Users/higuaifan/Desktop/hi/小工具/english/Plugins/VlaudeKit/Libs"

echo "Building session-reader-ffi (release)..."
cd "$PROJECT_DIR"
cargo build --release -p session-reader-ffi

DYLIB="$PROJECT_DIR/target/release/libsession_reader_ffi.dylib"
HEADER="$PROJECT_DIR/session-reader-ffi/include/session_reader_ffi.h"

if [ ! -f "$DYLIB" ]; then
    echo "Error: dylib not found at $DYLIB"
    exit 1
fi

if [ ! -f "$HEADER" ]; then
    echo "Error: header not found at $HEADER"
    exit 1
fi

# Fix install_name (使用无扩展名格式)
echo "Fixing install_name..."
install_name_tool -id "session_reader_ffi" "$DYLIB" 2>/dev/null || true

# Copy to Plugin Lib
echo "Copying to Plugin..."
mkdir -p "$PLUGIN_LIB_DIR"
cp "$DYLIB" "$PLUGIN_LIB_DIR/session_reader_ffi"
cp "$HEADER" "$PLUGIN_LIB_DIR/"

echo ""
echo "Done! Updated:"
echo "  - $PLUGIN_LIB_DIR/session_reader_ffi"
echo "  - $PLUGIN_LIB_DIR/session_reader_ffi.h"
echo "  Size: $(du -h "$PLUGIN_LIB_DIR/session_reader_ffi" | cut -f1)"

#!/bin/bash

echo "Building Tagger - CSV/TSV Tagger"
echo "================================"

# 检查Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

# 检查Rust
if ! command -v rustc &> /dev/null; then
    echo "Error: Rust is not installed"
    echo "Please install Rust from https://rustup.rs/"
    exit 1
fi

# 检查npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed"
    echo "Please install npm with Node.js"
    exit 1
fi

echo "Installing dependencies..."
npm install

echo "Building frontend..."
npm run build

echo "Building Tauri application..."
npm run tauri build

echo ""
echo "Build complete!"
echo ""
echo "The application has been built to:"
echo "  src-tauri/target/release/bundle/"
echo ""
echo "To run in development mode:"
echo "  npm run tauri dev"
echo ""
echo "To run the built application:"
echo "  ./src-tauri/target/release/tagger"
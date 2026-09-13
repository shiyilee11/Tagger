#!/bin/bash
set -e

echo "Starting Tagger in development mode"
echo "==================================="

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

echo "Installing dependencies..."
npm ci

echo "Starting development server..."
npm run tauri dev

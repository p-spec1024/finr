#!/bin/bash
# FINR — Termux Setup Script for Android
# Run this in Termux on your Android phone

echo "╔═══════════════════════════════════╗"
echo "║   FINR Termux Setup for Android   ║"
echo "╚═══════════════════════════════════╝"

# Update packages
echo "[1/6] Updating Termux packages..."
pkg update -y && pkg upgrade -y

# Install Node.js
echo "[2/6] Installing Node.js..."
pkg install nodejs -y

# Install git
echo "[3/6] Installing git..."
pkg install git -y

# Check versions
echo "[4/6] Checking versions..."
node --version
npm --version

# Install dependencies
echo "[5/6] Installing FINR dependencies..."
cd "$(dirname "$0")" || exit 1
npm install --production

# Start app
echo "[6/6] Starting FINR..."
echo ""
echo "✅ FINR starting on http://localhost:3000"
echo "   Open this in your phone browser or Chrome"
echo "   For external access, use ngrok or deploy to Railway"
echo ""
node server.js

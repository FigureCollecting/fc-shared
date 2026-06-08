#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Building fc-shared ==="
npm ci
npm run build

echo ""
echo "=== Build artifacts ==="
ls -la dist/

echo ""
echo "=== Type check ==="
npm run lint

echo ""
echo "Build successful"

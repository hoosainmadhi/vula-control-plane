#!/usr/bin/env bash
set -e

echo "=== Pushing vula-control-plane to GitHub (main, staging, dev) ==="
cd "$(dirname "$0")/.."

git push -u origin main
git push -u origin staging
git push -u origin dev

echo "✓ Successfully pushed main, staging, and dev to git@github.com:hoosainmadhi/vula-control-plane.git"

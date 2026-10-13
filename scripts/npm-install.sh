#!/bin/bash
cd "$(dirname "$0")/.."
npm install --no-audit --no-fund 2>&1 | tail -20
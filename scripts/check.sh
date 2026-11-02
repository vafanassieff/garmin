#!/usr/bin/env bash

set -euo pipefail

pnpm format
pnpm lint
pnpm type-check

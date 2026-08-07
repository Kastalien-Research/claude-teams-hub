#!/usr/bin/env bash
# Resolve the pinned celld v0.1.0 image for the local architecture.
#
# celld v0.1.0 (commit 553ae73f) was published to ghcr ONLY as per-arch tags —
# the combined `sha-…` manifest never landed and `latest` is celld 0.0.2
# (verified 2026-08-06; RFC 0001 §Deployment pins). Compose files cannot
# branch on architecture, so they read ${CELLD_IMAGE} and callers export it
# from this script:  export CELLD_IMAGE="$(scripts/celld-image.sh)"
set -euo pipefail

CELLD_COMMIT="553ae73f83c87c3f7c7a5f73c32c2211d9d7341f"

case "$(uname -m)" in
arm64 | aarch64) arch="arm64" ;;
x86_64 | amd64) arch="amd64" ;;
*)
  echo "unsupported architecture: $(uname -m)" >&2
  exit 1
  ;;
esac

echo "ghcr.io/denoland/celld:${CELLD_COMMIT}-${arch}"

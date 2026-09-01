#!/usr/bin/env bash
# Stage the Linux esbuild binary for the celld-deployer image.
#
# The repo pins esbuild exactly in devDependencies, but pnpm installs only the
# HOST platform binary (darwin on this Mac) — the deployer container needs the
# linux one. This stages @esbuild/linux-<arch> at the SAME pinned version from
# the npm registry into .tmp-hubdata/esbuild-linux/ (gitignored), where
# celld-deployer.Dockerfile COPYs it. No network installs happen at image
# build time and the version has a single source of truth: package.json.
set -euo pipefail

cd "$(dirname "$0")/.."

version="$(node -p "require('./package.json').devDependencies.esbuild")"
case "$(uname -m)" in
arm64 | aarch64) arch="arm64" ;;
x86_64 | amd64) arch="x64" ;;
*)
  echo "unsupported architecture: $(uname -m)" >&2
  exit 1
  ;;
esac

dest=".tmp-hubdata/esbuild-linux"
if [ -x "${dest}/esbuild" ] && "${dest}/esbuild" --version 2>/dev/null | grep -q "^${version}$"; then
  echo "staged esbuild ${version} already present at ${dest}/esbuild"
  exit 0
fi

mkdir -p "${dest}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
curl -fsSL "https://registry.npmjs.org/@esbuild/linux-${arch}/-/linux-${arch}-${version}.tgz" | tar xz -C "${tmp}"
cp "${tmp}/package/bin/esbuild" "${dest}/esbuild"
chmod +x "${dest}/esbuild"
echo "staged esbuild ${version} (linux-${arch}) at ${dest}/esbuild"

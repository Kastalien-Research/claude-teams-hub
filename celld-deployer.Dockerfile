# One-shot `celld deploy` image for the WorkspaceCell canary (RFC 0001).
#
# celld deploy shells out to esbuild for Worker bundling; this image carries
# the celld binary from the pinned v0.1.0 image plus the exact-pinned esbuild
# binary installed from the repo's node_modules (pnpm install puts the
# platform binary under node_modules/.pnpm; we copy the resolved bin).
#
# Build with the per-arch base selected by scripts/celld-image.sh:
#   docker build -f celld-deployer.Dockerfile \
#     --build-arg CELLD_IMAGE="$(scripts/celld-image.sh)" -t celld-deployer .
ARG CELLD_IMAGE
FROM ${CELLD_IMAGE} AS celld

FROM node:22-bookworm-slim
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
# esbuild's platform binary, staged by scripts/stage-esbuild.sh from the
# pnpm-installed exact pin (esbuild@0.25.12) — no network install at build time.
COPY .tmp-hubdata/esbuild-linux/esbuild /usr/local/bin/esbuild
RUN esbuild --version && celld --version
ENTRYPOINT ["/usr/local/bin/celld"]

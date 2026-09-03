#!/usr/bin/env bash
# hub18 lock manifest (instance 2): prints the sorted `<sha256>  <path>` list
# for every file under evaluator-i2/ except LOCK.sha256, lock-manifest.txt and
# .DS_Store, plus the line `S0 c182dce`. Paths are RELATIVE TO THE PARENT of
# evaluator-i2 (e.g. `evaluator-i2/tests/hub18-h6-bounded-latency.test.ts`),
# so the lock reproduces wherever the folder is moved or published. The task
# contract is covered through its copy evaluator-i2/TASK-instance-2.md.
# LOCK.sha256 = sha256 of this output.
#   make-manifest.sh                      # print manifest
#   make-manifest.sh | shasum -a 256      # the lock value
# bash + coreutils (find, sort, xargs, shasum) only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(basename "$HERE")"
cd "$HERE/.."
{
  find "$DIR" -type f \
    ! -name LOCK.sha256 ! -name lock-manifest.txt ! -name '.DS_Store' -print0 |
    LC_ALL=C sort -z | xargs -0 shasum -a 256
  echo "S0 c182dce"
} | LC_ALL=C sort

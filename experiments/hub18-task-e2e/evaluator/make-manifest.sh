#!/usr/bin/env bash
# hub18 lock manifest: prints the sorted `<sha256>  <path>` list for every file
# under mechanize/hub18/evaluator/ except LOCK.sha256 and lock-manifest.txt,
# plus mechanize/hub-issue-18-task.md, plus the S0 commit line. Paths are
# relative to the employment-ops-home root. LOCK.sha256 = sha256 of this output.
#   make-manifest.sh            # print manifest
#   make-manifest.sh | shasum -a 256
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
{
  find mechanize/hub18/evaluator -type f \
    ! -name LOCK.sha256 ! -name lock-manifest.txt ! -name '.DS_Store' -print0 |
    sort -z | xargs -0 shasum -a 256
  shasum -a 256 mechanize/hub-issue-18-task.md
  echo "S0 c182dce"
} | LC_ALL=C sort

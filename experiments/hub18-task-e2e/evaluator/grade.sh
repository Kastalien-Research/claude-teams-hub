#!/usr/bin/env bash
# hub18 evaluator: grade one candidate state.
#   grade.sh <worktree> <label> [patch ...]
# Restores <worktree> to HEAD (S0) with `git checkout -- . && git clean -fd`,
# applies the patches in order, runs F1..F3 + H2..H4 (vitest, JSON reporter),
# H5 (locked tests), H1 (pnpm test), and prints one summary row.
# Leaves the worktree in the graded state; never commits.
set -uo pipefail
WORKTREE="$(cd "$1" && pwd)"
LABEL="$2"
shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"
# Outputs live OUTSIDE evaluator/ so grading never changes the locked tree.
OUT="${GRADE_OUT:-$HERE/../grading}/$LABEL"
mkdir -p "$OUT"
PATCHES=()
for p in "$@"; do PATCHES+=("$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"); done
cd "$WORKTREE" || exit 2
git reset -q && git checkout -q -- . && git clean -qfd
for p in ${PATCHES[@]+"${PATCHES[@]}"}; do
  if ! git apply --whitespace=nowarn "$p" >"$OUT/apply.log" 2>&1; then
    echo "$LABEL | APPLY FAILED $p"
    cat "$OUT/apply.log"
    exit 2
  fi
done
git diff --name-only HEAD | sort >"$OUT/changed-files.txt"
GUARD="ok"
if grep -Eq '^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$' "$OUT/changed-files.txt"; then
  GUARD="DEPENDENCY-FILE-CHANGED"
fi
# flips + holds
DEST="$WORKTREE/src/celld/__tests__"
cp "$HERE"/tests/hub18-*.ts "$DEST"/
pnpm exec vitest run 'src/celld/__tests__/hub18-' --reporter=json --outputFile="$OUT/vitest.json" >"$OUT/vitest.log" 2>&1
trash "$DEST"/hub18-*.ts
# H5
if "$HERE/check-locked-tests.sh" "$WORKTREE" >"$OUT/h5.log" 2>&1; then H5=PASS; else H5=FAIL; fi
# H1
if pnpm test >"$OUT/h1.log" 2>&1; then H1=PASS; else H1=FAIL; fi
H1NOTE="$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/h1.log" | grep -Eo 'Tests +[0-9]+ (failed|passed).*\([0-9]+\)|error TS[0-9]+' | head -1 | tr -s ' ')"
python3 - "$OUT/vitest.json" "$LABEL" "$H1" "$H1NOTE" "$H5" "$GUARD" <<'PY'
import json, sys, os
path, label, h1, h1note, h5, guard = sys.argv[1:]
try:
    data = json.load(open(path))
except Exception as e:
    print(f"{label} | vitest json missing ({e})"); sys.exit(1)
cells = {}
for r in data.get('testResults', []):
    name = os.path.basename(r['name'])
    key = name.split('-')[1].upper()  # f1, f2, f3, h2, h3, h4
    failed = [a['fullName'] for a in r.get('assertionResults', []) if a['status'] != 'passed']
    ok = r['status'] == 'passed' and not failed
    cells[key] = ('PASS' if ok else 'FAIL', failed)
order = ['F1', 'F2', 'F3', 'H2', 'H3', 'H4']
row = ' '.join(f"{k}={cells.get(k, ('MISSING', []))[0]}" for k in order)
print(f"{label} | {row} H1={h1} H5={h5} | guard={guard} | h1: {h1note}")
for k in order:
    for f in cells.get(k, ('', []))[1]:
        print(f"    {k} failed: {f}")
PY

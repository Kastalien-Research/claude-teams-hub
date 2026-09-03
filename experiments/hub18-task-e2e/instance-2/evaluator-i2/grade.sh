#!/usr/bin/env bash
# hub18 evaluator (instance 2): grade one candidate state.
#   grade.sh <worktree> <label> [patch ...]
# Restores <worktree> to HEAD (S0) with `git checkout -- . && git clean -fd`,
# applies the patches in order, copies the evaluator tests in, runs each
# predicate file on its own (F1 F2 F3 F4 H2 H3 H4 H6 H7, vitest exit status),
# removes exactly the copied files (a leftover fails the grade), then H5
# (locked tests) and H1 (pnpm test), and prints one summary row.
# Outputs go to $GRADE_OUT/<label> (default ../grading-i2, OUTSIDE this dir).
# Leaves the worktree in the graded state; never commits.
# bash + coreutils + git + pnpm only. Exit: 0 graded, 2 apply failed,
# 3 cleanup failed.
set -euo pipefail
WORKTREE="$(cd "$1" && pwd)"
LABEL="$2"
shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${GRADE_OUT:-$HERE/../grading-i2}/$LABEL"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
PATCHES=()
for p in "$@"; do PATCHES+=("$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"); done
export NO_COLOR=1 FORCE_COLOR=0 CI=1
ESC="$(printf '\033')"
strip() { sed "s/$ESC\[[0-9;]*m//g"; }

cd "$WORKTREE"
git reset -q
git checkout -q -- .
git clean -qfd
: >"$OUT/apply.log"
for p in ${PATCHES[@]+"${PATCHES[@]}"}; do
  if ! git apply --whitespace=nowarn "$p" >>"$OUT/apply.log" 2>&1; then
    echo "$LABEL | APPLY FAILED $p"
    cat "$OUT/apply.log"
    exit 2
  fi
done
git diff --name-only HEAD | LC_ALL=C sort >"$OUT/changed-files.txt"
GUARD="ok"
if grep -Eq '^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$' "$OUT/changed-files.txt"; then
  GUARD="DEPENDENCY-FILE-CHANGED"
fi

# Flips + vitest holds: copy the evaluator tests in, run each predicate file alone.
DEST="$WORKTREE/src/celld/__tests__"
COPIED=()
for f in "$HERE"/tests/hub18-*.ts; do
  cp "$f" "$DEST/"
  COPIED+=("$DEST/$(basename "$f")")
done
ROW=""
DETAIL=""
for P in f1 f2 f3 f4 h2 h3 h4 h6 h7; do
  FILES=()
  for f in "$DEST"/hub18-"$P"-*.test.ts; do FILES+=("src/celld/__tests__/$(basename "$f")"); done
  if [ "${#FILES[@]}" -eq 0 ]; then ROW="$ROW $(printf "%s" "$P" | tr a-z A-Z)=MISSING"; continue; fi
  if pnpm exec vitest run "${FILES[@]}" >"$OUT/$P.log" 2>&1; then R=PASS; else R=FAIL; fi
  ROW="$ROW $(printf "%s" "$P" | tr a-z A-Z)=$R"
  if [ "$R" = FAIL ]; then
    while IFS= read -r line; do DETAIL="$DETAIL"$'\n'"    $(printf "%s" "$P" | tr a-z A-Z) failed: $line"; done < <(strip <"$OUT/$P.log" | grep -E '^ *× ' | sed 's/^ *× //; s/ [0-9]*ms$//' || true)
  fi
done
rm -f "${COPIED[@]}"
for f in "${COPIED[@]}"; do
  if [ -e "$f" ]; then echo "$LABEL | CLEANUP FAILED $f still present"; exit 3; fi
done

# H5
if "$HERE/check-locked-tests.sh" "$WORKTREE" >"$OUT/h5.log" 2>&1; then H5=PASS; else H5=FAIL; fi
# H1
if pnpm test >"$OUT/h1.log" 2>&1; then H1=PASS; else H1=FAIL; fi
H1NOTE="$(strip <"$OUT/h1.log" | grep -Eo 'Tests +[0-9]+ (failed|passed).*\([0-9]+\)|error TS[0-9]+' | head -1 | tr -s ' ' || true)"

echo "$LABEL |${ROW} H1=$H1 H5=$H5 | guard=$GUARD | h1: $H1NOTE"
if [ -n "$DETAIL" ]; then printf '%s\n' "${DETAIL#$'\n'}"; fi

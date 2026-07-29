#!/usr/bin/env python3
"""Refuse to commit a session that left no reasoning behind.

WHY THIS IS A HOOK AND NOT A CONVENTION

`20_require_hub_presence.py` asks whether anyone could SEE the work. This asks
whether anything survives it. A commit records what the tree looks like now; it
records nothing about which options were considered, what was assumed, or which
actions were taken and whether they can be undone. That context lives only in
the session transcript, which is discarded, and in the agent's head, which is
discarded harder.

The thought stream is where it goes instead. Logging it is, again, pure
instruction -- and instruction that costs a tool call at exactly the moment the
agent believes it is finished. So the commit is where the question gets asked.

WHAT COUNTS AS A RECEIPT

Any `manifest.json` under `$HUB_DATA_DIR/projects/` written in the last 30
minutes. The check is deliberately shallow: it verifies that thoughts were
recorded during THIS working window, not that they were good. Grading content
is a job for a reader, and a guard that tried would either be trivially gamed by
a filler thought or would block honest work it misjudged.

Sessions live at `projects/<project>/sessions/<partition>/<sessionId>/` with a
monthly partition, but `filesystem-storage.ts` also reads and migrates a FLAT
`projects/<project>/sessions/<sessionId>/` layout, so this walks for
`manifest.json` at any depth rather than assuming one shape.

Future mtimes never count -- a single `touch -t 209901010000` would otherwise
disable this permanently.

FAILING CLOSED IS STRICT HERE, ON PURPOSE

Any unreadable directory encountered during the walk blocks, even when a fresh
manifest was also found. Partial visibility into the receipt store cannot
distinguish "you logged your reasoning" from "something is hiding whether you
did", and the hatch below is the pressure-release valve for the rare honest
case.

THE ESCAPE HATCH IS DELIBERATE AND VISIBLE

`# no-hub: <reason>` at the end of the command, recorded verbatim by the command
audit log -- same contract as hook 20, deliberately the same token so an
operator suppresses both with one spelling.
"""
import errno
import json
import os
import re
import sys
import time

WINDOW_SECONDS = 30 * 60

GLOBAL_FLAGS = r"(?:\s+-(?:-\S+|[a-zA-Z])(?:[= ]\S+)?)*"
COMMIT = re.compile(r"\bgit\b" + GLOBAL_FLAGS + r"\s+commit\b")


class Unreadable(Exception):
    """Receipt state that exists but cannot be read. Never treated as absence."""


def strip_quoted(command: str) -> str:
    """Blank single- and double-quoted spans -- naming an operation is not doing it."""
    return re.sub(r"'[^']*'|\"[^\"]*\"", " ", command)


def fresh_receipt(projects_dir: str, now: float) -> bool:
    """True when some session manifest under `projects_dir` is inside the window.

    `os.walk` swallows directory errors by default, which would silently turn a
    permission failure into "no receipts found" -- the wrong message for the
    wrong reason. `onerror` captures them instead; ENOENT means the store has
    not been created yet, anything else fails closed.
    """
    errors = []
    found = False
    for dirpath, _dirnames, filenames in os.walk(projects_dir, onerror=errors.append):
        if "manifest.json" not in filenames:
            continue
        try:
            age = now - os.stat(os.path.join(dirpath, "manifest.json")).st_mtime
        except OSError as exc:
            if exc.errno == errno.ENOENT:
                continue
            raise Unreadable(f"{dirpath}/manifest.json ({exc.strerror})") from exc
        # Negative age = future mtime; it can never establish that work happened.
        if 0 <= age <= WINDOW_SECONDS:
            found = True

    for exc in errors:
        if getattr(exc, "errno", None) != errno.ENOENT:
            raise Unreadable(f"{getattr(exc, 'filename', projects_dir)} ({exc.strerror})")
    return found


def main() -> int:
    workspace = (os.environ.get("HUB_WORKSPACE") or "").strip()
    data_dir = (os.environ.get("HUB_DATA_DIR") or "").strip()
    if not workspace or not data_dir:
        return 0

    data = json.load(sys.stdin)
    command = ((data.get("tool_input") or {}).get("command") or "").strip()
    if not command:
        return 0

    stripped = strip_quoted(command)
    if re.search(r"#\s*no-hub:[^\n]*\s*$", stripped):
        return 0

    segments = [
        segment.strip()
        for segment in re.split(r"&&|\|\||;|\||\n", stripped)
        if segment.strip()
    ]
    if not any(COMMIT.search(segment) for segment in segments):
        return 0

    projects_dir = os.path.join(data_dir, "projects")
    try:
        if fresh_receipt(projects_dir, time.time()):
            return 0
    except Unreadable as exc:
        print(
            f"Blocked: cannot read the thought store under {projects_dir} -- {exc}.\n\n"
            "Failing closed. Unreadable state is indistinguishable from tampered "
            "state, so it cannot be read as 'nothing to enforce'. Fix the "
            "permissions, or unset HUB_WORKSPACE/HUB_DATA_DIR if this session is "
            "genuinely not part of a team.",
            file=sys.stderr,
        )
        return 2

    print(
        f"Blocked: no thought receipts recorded in the last {WINDOW_SECONDS // 60} "
        f"minutes (looked for session manifests under {projects_dir}).\n\n"
        "Log the findings before committing them -- the commit keeps the code, "
        "the thought stream is the only thing that keeps the reasoning:\n\n"
        "  tb.thought({ thoughtType: 'decision_frame', thought: '<what was decided "
        "and what was rejected>', nextThoughtNeeded: true })\n"
        "  tb.thought({ thoughtType: 'action_report', thought: '<what was done>', "
        "actionResult: { success, reversible, tool, target } })\n\n"
        "decision_frame for choices, action_report for actions actually taken -- "
        "`reversible` is the field a reviewer reads first when something needs "
        "undoing.\n"
        "If this commit genuinely carries no reasoning worth keeping, append "
        "`# no-hub: <reason>` to the command -- that reason is recorded by the "
        "command audit log, so the exception is reviewable rather than invisible.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())

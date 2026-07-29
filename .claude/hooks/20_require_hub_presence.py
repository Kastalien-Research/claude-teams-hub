#!/usr/bin/env python3
"""Refuse to ship work that never showed up in the hub.

WHY THIS IS A HOOK AND NOT A CONVENTION

A Claude agent team coordinates through the Hub: register, claim a problem, post
to its channel. All of that is instruction, and instruction loses to task
momentum every time -- the work is right there, coordinating is four MCP calls
away. An agent that skips it still produces a perfectly good commit, so nothing
ever notices, and the team silently degrades into parallel solo sessions that
happen to share a repo. Commits and PRs are the visible output of a work
session, which makes them the one place the question "could anyone else see you
do this?" can actually be asked.

CONDITIONAL BY CONSTRUCTION

`HUB_WORKSPACE` and `HUB_DATA_DIR` are what an operator sets when a session is
part of a team. With either unset this exits 0 immediately having read nothing:
a solo session in a repo that vendors these hooks pays no cost and sees no
output. Setting them is the declaration "this is a hub session", which is why a
MISSING workspace directory blocks rather than opting out -- the operator said
there is a hub, so absent hub state is absent PRESENCE, not absent enforcement.

WHAT COUNTS AS PRESENCE

Two independent facts, both required, because either one alone is satisfied once
and then stays satisfied forever:

  1. Identity -- some problem in this workspace has `assignedTo` set and status
     `in-progress`. Somebody is on the hook for this work by name.
  2. Liveness -- something under `problems/` or `channels/` was written in the
     last 30 minutes. Without this, a workspace claimed weeks ago and abandoned
     would authorise every commit made since.

A future mtime never establishes liveness. One `touch -t 209901010000` would
otherwise disable the liveness half permanently, which is the same defect
`17_require_process.py` fixed in its ledger window.

THE ESCAPE HATCH IS DELIBERATE AND VISIBLE

Append `# no-hub: <reason>` to the command. The reason is captured verbatim by
the ambient command audit log, so skipping shows up as a signal to review rather
than as silence. A guard with no exit wedges legitimate work -- a hotfix while
the hub server is down -- and being wedged is precisely what trains an agent to
route around guards habitually, which hollows the hatch out.
"""
import errno
import json
import os
import re
import sys
import time

WINDOW_SECONDS = 30 * 60

# `git -c user.name=x commit` and `gh --repo o/r pr create` are the same
# operations as the bare spellings; without this tolerance either one walks past
# the guard. Borrowed verbatim from `17_require_process.py`.
GLOBAL_FLAGS = r"(?:\s+-(?:-\S+|[a-zA-Z])(?:[= ]\S+)?)*"
TRIGGERS = (
    (re.compile(r"\bgit\b" + GLOBAL_FLAGS + r"\s+commit\b"), "git commit"),
    (re.compile(r"\bgh\b" + GLOBAL_FLAGS + r"\s+pr\s+create\b"), "gh pr create"),
)


class Unreadable(Exception):
    """Hub state that exists but cannot be read. Never treated as absence."""


def strip_quoted(command: str) -> str:
    """Blank single- and double-quoted spans -- naming an operation is not doing it.

    `echo "git commit"` and `git commit -m "no-hub: later"` both used to trip the
    raw-text version: the first was refused for prose, the second manufactured an
    exemption out of a commit subject.
    """
    return re.sub(r"'[^']*'|\"[^\"]*\"", " ", command)


def json_files(directory: str) -> list:
    """The `*.json` files directly under `directory`.

    ENOENT yields an empty list, not an error: the server creates these
    subdirectories lazily on first write, so "no problems/ yet" is genuinely "no
    problem has been claimed" -- which the caller already blocks on. Every other
    failure is indistinguishable from tampering and is raised.
    """
    try:
        names = sorted(os.listdir(directory))
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            return []
        raise Unreadable(f"{directory} ({exc.strerror})") from exc
    return [os.path.join(directory, name) for name in names if name.endswith(".json")]


def any_claimed(paths) -> bool:
    """True when some problem file names an owner and is in flight.

    A file that vanished mid-scan or does not parse is skipped rather than
    raised: neither can evidence a claim, and the skip direction only makes the
    guard harder to satisfy.
    """
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                row = json.load(handle)
        except OSError as exc:
            if exc.errno == errno.ENOENT:
                continue
            raise Unreadable(f"{path} ({exc.strerror})") from exc
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("assignedTo") and row.get("status") == "in-progress":
            return True
    return False


def any_recent(paths, now: float) -> bool:
    for path in paths:
        try:
            age = now - os.stat(path).st_mtime
        except OSError as exc:
            if exc.errno == errno.ENOENT:
                continue
            raise Unreadable(f"{path} ({exc.strerror})") from exc
        # A future mtime yields a negative age, which passes any `age <= WINDOW`
        # test forever. Skip rather than stop: later files may be honest.
        if age < 0:
            continue
        if age <= WINDOW_SECONDS:
            return True
    return False


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

    # Anchored to the END of the quote-stripped command: unanchored, the
    # substring `# no-hub:` anywhere -- including inside a commit subject --
    # manufactures a reviewed exception out of prose.
    if re.search(r"#\s*no-hub:[^\n]*\s*$", stripped):
        return 0

    # Judged per shell segment, so `ls && git commit -m x` is gated on the
    # commit rather than excused by the `ls` standing in front of it. Quote
    # stripping has already run, so a separator inside a string does not split.
    segments = [
        segment.strip()
        for segment in re.split(r"&&|\|\||;|\||\n", stripped)
        if segment.strip()
    ]
    operation = next(
        (name for pattern, name in TRIGGERS if any(pattern.search(s) for s in segments)),
        None,
    )
    if operation is None:
        return 0

    root = os.path.join(data_dir, "hub", "workspaces", workspace)
    try:
        problems = json_files(os.path.join(root, "problems"))
        channels = json_files(os.path.join(root, "channels"))
        claimed = any_claimed(problems)
        recent = any_recent(problems + channels, time.time())
    except Unreadable as exc:
        print(
            f"Blocked: cannot read hub state under {root} -- {exc}.\n\n"
            "Failing closed. Unreadable state is indistinguishable from tampered "
            "state, so it cannot be read as 'no hub configured'. Fix the "
            "permissions, or unset HUB_WORKSPACE/HUB_DATA_DIR if this session is "
            "genuinely not part of a team.",
            file=sys.stderr,
        )
        return 2

    if claimed and recent:
        return 0

    missing = []
    if not claimed:
        missing.append("no problem is claimed (assignedTo set, status in-progress)")
    if not recent:
        missing.append(f"nothing written under problems/ or channels/ in {WINDOW_SECONDS // 60} minutes")

    print(
        f"Blocked: `{operation}` in hub workspace `{workspace}` with no visible hub "
        f"presence -- {'; '.join(missing)}.\n\n"
        "Join the hub before shipping, via the team-hub MCP Code Mode surface:\n\n"
        "  tb.hub.register({ role, capabilities })\n"
        f"  tb.hub.quickJoin({{ workspaceId: '{workspace}' }})   // or claimProblem({{ problemId }})\n"
        "  tb.hub.postMessage({ problemId, content })          // say what you are doing\n\n"
        "claimProblem is what sets assignedTo and moves the problem to "
        "in-progress; postMessage is what makes the work legible to the rest of "
        "the team while it is happening rather than after.\n"
        "If this genuinely is not team work, append `# no-hub: <reason>` to the "
        "command -- that reason is recorded by the command audit log, so the "
        "exception is reviewable rather than invisible.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Route every change to hub state through the hub server.

WHY THIS IS A HOOK AND NOT A CONVENTION

`hub-storage-fs.ts` is a single-writer store: its appends are read-modify-write
on JSON files and are safe only because exactly one server process performs
them. A hand edit is a second writer. It also skips everything the server does
on the way in -- id generation, the workspace/problem cross-references, the
`updatedAt` stamp -- so the cheapest failure is a file that still parses and
quietly disagrees with the rest of the store.

The blast radius is the whole point of the hub. `20_require_hub_presence.py`
reads exactly these files to decide whether an agent showed up; an agent that
can write them can also write itself a claim it never made. A guard whose
evidence store is agent-writable is decoration.

WHAT IS ALLOWED

Reads. `cat`, `ls`, `jq`, `grep`, `wc` and the dashboard all work untouched --
only mutation is routed. `cp` and `mv` of a guarded path are refused even when
they only copy state OUT, because distinguishing a backup from a staged
overwrite by regex is not something to be confident about, and being wrong
toward refusal costs one MCP call.

THERE IS NO ESCAPE HATCH, DELIBERATELY

Hooks 20 and 21 gate operations an agent may legitimately need to perform by
hand, so they carry a recorded `# no-hub:` exit. This gates an artifact whose
only sanctioned writer is a running server that does strictly more. A hatch here
would only ever be used to do the thing that corrupts the store -- including, if
the store is being edited to fake presence, by the exact agent the other two
hooks are asking about. A trailing `# no-hub:` on the command changes nothing.

This hook does NOT require `HUB_WORKSPACE`: the store is worth protecting
whenever it could exist, so with `HUB_DATA_DIR` unset it guards the server's own
default of `~/.team-hub/hub`.
"""
import json
import os
import pathlib
import re
import sys

# Matched against the segment with quote CHARACTERS stripped (not the spans
# blanked), because a quoted path is still a path: `rm -rf "$HUB_DATA_DIR/hub"`
# must not read as prose. Each entry additionally requires the guarded root to be
# named in the same segment -- see the loop in `main`. Lifted from
# `18_protect_decisions.py`, whose table this store has the same need for.
MUTATORS = (
    (re.compile(r"\btee\b"), "tee writing into"),
    (re.compile(r"\b(?:sed|perl|ruby|awk)\b[^\n]*(?:^|\s)-i"), "an in-place edit of"),
    (re.compile(r"\b(?:mv|cp|install|ln|dd|rsync)\b"), "a file operation on"),
    (re.compile(r"\b(?:rm|trash|unlink|shred|truncate)\b"), "removing or truncating"),
    (re.compile(r"\bgit\b[^\n]*\b(?:checkout|restore)\b"), "a git restore of"),
)

# Bash starts a new command after these; a mutation is judged per command so a
# `rm` cannot launder itself through a read sitting next to it.
SEGMENT_BOUNDARY = re.compile(r"&&|\|\||[;|\n()`]")


def guarded_root() -> tuple:
    """The protected directory, plus the literal `HUB_DATA_DIR` text if it was set.

    Both are needed. The resolved path is what a tool payload is compared
    against; the literal is what a shell command is likely to SPELL, and on
    macOS the two differ for any path under `/tmp` or `/var` because those are
    symlinks into `/private`.
    """
    raw = (os.environ.get("HUB_DATA_DIR") or "").strip()
    base = pathlib.Path(raw).expanduser() if raw else pathlib.Path.home() / ".team-hub"
    if not base.is_absolute():
        base = pathlib.Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())) / base
    return (base / "hub").resolve(), raw


def spellings(guarded: pathlib.Path, raw: str) -> list:
    """Every way the guarded root is plausibly written in a shell command.

    A path comparison cannot be used here: the command is text, and the text may
    name the directory through the variable, through `~`, or through an
    unresolved symlink. Missing a spelling is a bypass, so all of them are
    checked as prefixes.
    """
    found = {str(guarded)}
    if raw:
        found.add(str(pathlib.Path(raw).expanduser() / "hub"))
        found.add(raw.rstrip("/") + "/hub")
    else:
        found.add(str(pathlib.Path.home() / ".team-hub" / "hub"))
    home = str(pathlib.Path.home())
    for text in list(found):
        if text.startswith(home + os.sep):
            found.add("~" + text[len(home):])
            found.add("$HOME" + text[len(home):])
    found.add("$HUB_DATA_DIR/hub")
    found.add("${HUB_DATA_DIR}/hub")
    return sorted(found, key=len, reverse=True)


def unquote(text: str) -> str:
    """Drop quote characters, keeping their contents. A quoted path is a path."""
    return text.replace("'", "").replace('"', "")


def under(target: pathlib.Path, guarded: pathlib.Path) -> bool:
    return target == guarded or guarded in target.parents


def die(what: str, guarded: pathlib.Path) -> None:
    print(
        f"Blocked: {what} {guarded}.\n\n"
        "Hub state is written by the team-hub server and nothing else. Its files "
        "are single-writer read-modify-write JSON, and `20_require_hub_presence.py` "
        "reads them as evidence -- a hand edit either corrupts the store or forges "
        "that evidence.\n\n"
        "Change it through the MCP surface instead:\n\n"
        "  tb.hub.claimProblem / updateProblem / postMessage / propose / endorse\n\n"
        "Reads are not blocked: `cat`, `ls`, `jq` and `grep` on these paths all "
        "work. There is deliberately no override -- removing hub state by hand is "
        "a human job, done in an editor, outside the agent.",
        file=sys.stderr,
    )
    sys.exit(2)


def main() -> int:
    data = json.load(sys.stdin)
    tool_input = data.get("tool_input") or {}
    guarded, raw = guarded_root()

    # Every file-writing tool names its target with one of these. Compared by
    # RESOLVED path rather than by string, so `hub/../hub/agents.json`, a `~`
    # spelling and an absolute one all land on the same answer.
    for key in ("file_path", "notebook_path"):
        given = (tool_input.get(key) or "").strip()
        if not given:
            continue
        path = pathlib.Path(given).expanduser()
        if not path.is_absolute():
            path = pathlib.Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())) / path
        if under(path.resolve(), guarded):
            die("direct writes to", guarded)

    command = (tool_input.get("command") or "").strip()
    if not command:
        return 0

    root_token = (
        "(?:" + "|".join(re.escape(text) for text in spellings(guarded, raw)) + r")(?![\w.-])"
    )
    names_root = re.compile(root_token)
    # The redirect target is anchored to the guarded root, unlike the other
    # mutators, so that reading state and writing the result elsewhere --
    # `cat "$HUB_DATA_DIR/hub/agents.json" > /tmp/copy.json` -- is not mistaken
    # for a write INTO the store.
    redirect = re.compile(r">>?\s*[^\s;|&]*" + root_token)

    for segment in SEGMENT_BOUNDARY.split(command):
        bare = unquote(segment)
        if not names_root.search(bare):
            continue
        if redirect.search(bare):
            die("a shell redirect into", guarded)
        for pattern, description in MUTATORS:
            if pattern.search(bare):
                die(description, guarded)

    return 0


if __name__ == "__main__":
    sys.exit(main())

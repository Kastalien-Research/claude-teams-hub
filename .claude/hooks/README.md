# Hub enforcement hooks

Three Claude Code `PreToolUse` hooks that make hub participation a precondition of
shipping, rather than a suggestion. They exist because a Claude agent team coordinates
through instructions, and instructions lose to task momentum: an agent that skips
registering, claiming and posting still produces a perfectly good commit, so nothing
notices, and a team quietly degrades into parallel solo sessions sharing a repo.

Commits and PRs are where this becomes checkable — they are the visible output of a work
session, so they are the one place to ask "could anyone else see you do this?"

| Hook | Fires on | Passes when |
| --- | --- | --- |
| `20_require_hub_presence.py` | `git commit`, `gh pr create` | a problem in the workspace is claimed **and** the workspace was written to recently |
| `21_require_thought_receipts.py` | `git commit` | a session manifest was written recently |
| `22_protect_hub_state.py` | `Edit`/`Write`/`NotebookEdit`/`Bash` | the operation is not a hand-mutation of the hub store |

## The env-var contract: unset means inert

Hooks 20 and 21 read `HUB_WORKSPACE` and `HUB_DATA_DIR`. **With either unset or empty
they exit 0 immediately, having read nothing and printed nothing.** A solo session in a
repo that vendors these hooks pays no cost and sees no output.

Setting both is the operator's declaration that this session is part of a team. That is
why a *missing* workspace directory blocks rather than opting out: the operator said
there is a hub, so absent hub state is absent **presence**, not absent enforcement.

```bash
export HUB_DATA_DIR="$HOME/.team-hub"   # must match what the team-hub server runs with
export HUB_WORKSPACE="ws-alpha"
```

Hook 22 is the exception — it does **not** require `HUB_WORKSPACE`, and with
`HUB_DATA_DIR` unset it guards the server's own default of `~/.team-hub/hub`. The store
is worth protecting whenever it could exist.

## What the hooks read

Ground truth is `src/hub/hub-storage-fs.ts` and `src/persistence/filesystem-storage.ts`.

```
$HUB_DATA_DIR/
  hub/
    agents.json
    workspaces/<workspaceId>/
      workspace.json
      problems/<problemId>.json      # { id, workspaceId, assignedTo?, status, ... }
      proposals/<proposalId>.json
      consensus/<markerId>.json
      channels/<channelId>.json      # { id, workspaceId, problemId, messages: [...] }
  projects/<project>/sessions/
      <YYYY-MM>/<sessionId>/manifest.json    # partitioned (usual)
      <sessionId>/manifest.json              # flat (also occurs; migrated on read)
```

Hook 21 walks for `manifest.json` at any depth rather than assuming one layout, because
`filesystem-storage.ts` reads and migrates both shapes.

## The 30-minute window

Both gating hooks require *liveness*, not just existence: something must have been
written in the last 30 minutes. Without it, a workspace claimed weeks ago and abandoned
would authorise every commit made since, and one `tb.thought` call in a session's first
minute would cover an eight-hour session.

Hook 20 accepts recency from any file under `problems/` or `channels/`. Hook 20's other
half — a problem with `assignedTo` set and status `in-progress` — is *identity*: somebody
is on the hook for this work by name. Both are required, because either alone is
satisfied once and then stays satisfied forever.

**Future mtimes never count.** A negative age passes any `age <= WINDOW` test forever, so
a single `touch -t 209901010000` would otherwise disable the liveness half permanently.

## Failing closed

`ENOENT` means "this store has not been created yet" and is read as absence, which
produces the ordinary steering block. **Every other read failure** — permission denied,
a path that is a directory, an I/O error — exits 2 with a different message, because
unreadable state is indistinguishable from tampered state and must not be read as "no hub
configured". Hook 21 is strict about this even when it also found a fresh manifest:
partial visibility into the receipt store cannot distinguish "you logged your reasoning"
from "something is hiding whether you did".

## Escape hatches

Hooks 20 and 21 honour `# no-hub: <reason>` **anchored at the end of the command**:

```bash
git commit -m "hotfix" # no-hub: hub server is down, paging the operator
```

The reason is captured verbatim by the ambient command audit log, so skipping is a
reviewable signal rather than silence. A guard with no exit wedges legitimate work, and
being wedged is exactly what trains an agent to route around guards habitually — which
hollows the hatch out.

The anchoring and quote-stripping are load-bearing. `git commit -m "# no-hub: whatever"`
does **not** exempt (the token is prose inside a message), and neither does a hatch on an
earlier line of a multi-line command (a shell comment excuses its own line, not the next).

**Hook 22 has no hatch, deliberately.** Hooks 20 and 21 gate operations an agent may
legitimately need to do by hand. Hook 22 gates an artifact whose only sanctioned writer is
a running server that does strictly more, and whose files hook 20 reads *as evidence* — so
a hatch would only ever be used either to corrupt the store or to forge the presence the
other hooks are asking about. A trailing `# no-hub:` on a `rm -rf "$HUB_DATA_DIR/hub"`
changes nothing.

## What hook 22 blocks

Only mutation. `cat`, `ls`, `jq`, `grep`, `wc` and the dashboard are untouched, including
reading state and redirecting the result elsewhere
(`cat "$HUB_DATA_DIR/hub/agents.json" > /tmp/copy.json` passes — the redirect target is
anchored to the guarded root).

Blocked: `Write`/`Edit`/`NotebookEdit` resolving under the root (`~`, `..` and
relative spellings all resolve first), and Bash segments that *both* name the root and
match a mutator — redirects into it, `tee`, in-place `sed|perl|ruby|awk -i`,
`mv|cp|install|ln|dd|rsync`, `rm|trash|unlink|shred|truncate`, `git checkout|restore`.
Judged per shell segment, so a `rm` cannot launder itself through a read next to it.

`cp` and `mv` of a guarded path are refused even when they only copy state *out*.
Distinguishing a backup from a staged overwrite by regex is not something to be confident
about, and being wrong toward refusal costs one MCP call.

## Wiring

`../settings.json` already wires all three for sessions launched inside this repo.

To adopt them in a **consuming repo**, merge this into that repo's `.claude/settings.json`
and replace `/abs/path/to/team-hub` with the checkout path. `$CLAUDE_PROJECT_DIR` points
at the *consuming* repo, so the hooks must be referenced absolutely:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/to/team-hub/.claude/hooks/20_require_hub_presence.py",
            "timeout": 10,
            "statusMessage": "Hub: is anyone able to see this work?"
          },
          {
            "type": "command",
            "command": "/abs/path/to/team-hub/.claude/hooks/21_require_thought_receipts.py",
            "timeout": 10,
            "statusMessage": "Hub: were the findings logged?"
          }
        ]
      },
      {
        "matcher": "Edit|Write|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/to/team-hub/.claude/hooks/22_protect_hub_state.py",
            "timeout": 10,
            "statusMessage": "Hub: protecting the hub state store"
          }
        ]
      }
    ]
  }
}
```

Claude Code merges hook arrays across settings files, so this coexists with a repo's
existing `PreToolUse` entries. The hooks need Python 3 and the standard library only.

## Tests

Nothing imports these hooks, so the suite runs them the way Claude Code does —
`python3 <hook>.py` with the event JSON on stdin — and asserts on the exit code and
streams. The child environment is built from scratch and never inherits `os.environ`;
every hook branches on `HUB_DATA_DIR`, `HUB_WORKSPACE` or `HOME`, so a leaked ambient
value would point a test at the developer's real `~/.team-hub` or make an "env unset" case
pass for the wrong reason.

```bash
uv run --with pytest pytest -q /abs/path/to/team-hub/.claude/hooks/tests
```

`pytest` is not installed globally; `uv` provides it per-run. The chmod-based fail-closed
tests skip automatically when running as root, which ignores permission bits.

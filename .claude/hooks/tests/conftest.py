"""Shared fixtures for the team-hub hook suite.

Nothing imports these hooks -- Claude Code runs them as `python3 <hook>.py` with
the event JSON on stdin -- so the only honest test runs them the same way and
asserts on the exit code and streams. Protocol, read off the hook sources:
exit 0 allows, exit 2 denies and stderr is the reason shown to the model.

HERMETICITY. `run_hook` builds the child environment FROM SCRATCH and never
spreads `os.environ`. Every one of these hooks branches on `HUB_DATA_DIR`,
`HUB_WORKSPACE` or `HOME`, so a leaked ambient value would either point a test
at the developer's real `~/.team-hub` or make an "env unset" case silently
pass for the wrong reason. `PATH` is the only inherited variable, because the
child needs an interpreter. Same rationale as
`dev-processes/hook-regression/hook-harness.ts` in the parent repo.
"""
import json
import os
import pathlib
import subprocess
import time

HOOKS_DIR = pathlib.Path(__file__).resolve().parent.parent

# chmod-based fail-closed tests are meaningless as root, which ignores modes.
IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0


def run_hook(hook: str, payload: dict, env: dict) -> subprocess.CompletedProcess:
    child = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    child.update({key: str(value) for key, value in env.items() if value is not None})
    return subprocess.run(
        ["python3", str(HOOKS_DIR / hook)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=child,
    )


def bash(command: str) -> dict:
    return {"tool_name": "Bash", "tool_input": {"command": command}}


def write(path, tool: str = "Write", key: str = "file_path") -> dict:
    return {"tool_name": tool, "tool_input": {key: str(path)}}


def hub_env(data_dir=None, workspace=None, home=None) -> dict:
    """A child environment. Omitted keys are genuinely absent, not empty."""
    env = {}
    if data_dir is not None:
        env["HUB_DATA_DIR"] = str(data_dir)
    if workspace is not None:
        env["HUB_WORKSPACE"] = workspace
    if home is not None:
        env["HOME"] = str(home)
    return env


def set_age(path, seconds: float) -> None:
    """Backdate `path` by `seconds`. Negative values place it in the FUTURE."""
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def workspace_dir(data_dir, workspace: str) -> pathlib.Path:
    return pathlib.Path(data_dir) / "hub" / "workspaces" / workspace


def seed_problem(
    data_dir,
    workspace: str,
    problem_id: str = "prob-1",
    assigned_to="agent-1",
    status: str = "in-progress",
    age: float = 0,
) -> pathlib.Path:
    """A problem file shaped like `hub-storage-fs.ts` writes them."""
    path = workspace_dir(data_dir, workspace) / "problems" / f"{problem_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "id": problem_id,
        "workspaceId": workspace,
        "title": "seeded",
        "description": "seeded",
        "createdBy": "agent-1",
        "status": status,
        "comments": [],
        "createdAt": "2026-07-29T00:00:00.000Z",
        "updatedAt": "2026-07-29T00:00:00.000Z",
    }
    if assigned_to is not None:
        body["assignedTo"] = assigned_to
    path.write_text(json.dumps(body), encoding="utf-8")
    set_age(path, age)
    return path


def seed_channel(
    data_dir, workspace: str, channel_id: str = "prob-1", age: float = 0
) -> pathlib.Path:
    path = workspace_dir(data_dir, workspace) / "channels" / f"{channel_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "id": channel_id,
                "workspaceId": workspace,
                "problemId": channel_id,
                "messages": [
                    {
                        "id": "msg-1",
                        "agentId": "agent-1",
                        "content": "starting",
                        "timestamp": "2026-07-29T00:00:00.000Z",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    set_age(path, age)
    return path


def seed_manifest(
    data_dir,
    project: str = "team-hub",
    session: str = "sess-1",
    partition="2026-07",
    age: float = 0,
) -> pathlib.Path:
    """A session manifest. `partition=None` produces the FLAT layout.

    Both shapes occur -- `filesystem-storage.ts` migrates the flat one -- so the
    hook has to find either.
    """
    root = pathlib.Path(data_dir) / "projects" / project / "sessions"
    session_dir = root / partition / session if partition else root / session
    session_dir.mkdir(parents=True, exist_ok=True)
    manifest = session_dir / "manifest.json"
    manifest.write_text(json.dumps({"id": session, "project": project}), encoding="utf-8")
    set_age(manifest, age)
    return manifest

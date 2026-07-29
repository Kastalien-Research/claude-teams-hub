"""Behaviour of 20_require_hub_presence.py, probed rather than read."""
import os

import pytest
from conftest import (
    IS_ROOT,
    bash,
    hub_env,
    run_hook,
    seed_channel,
    seed_problem,
    set_age,
    workspace_dir,
)

HOOK = "20_require_hub_presence.py"
WS = "ws-alpha"
STALE = 45 * 60


def present(tmp_path, **kwargs):
    """A workspace satisfying both halves: a claim, and recent activity."""
    seed_problem(tmp_path, WS, **kwargs)
    seed_channel(tmp_path, WS)
    return hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")


def test_inert_when_env_unset(tmp_path):
    result = run_hook(HOOK, bash("git commit -m x"), hub_env(home=tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_inert_when_only_workspace_set(tmp_path):
    result = run_hook(HOOK, bash("git commit -m x"), hub_env(workspace=WS, home=tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_inert_when_only_data_dir_set(tmp_path):
    result = run_hook(HOOK, bash("git commit -m x"), hub_env(data_dir=tmp_path, home=tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_claimed_and_fresh_passes(tmp_path):
    assert run_hook(HOOK, bash("git commit -m x"), present(tmp_path)).returncode == 0


def test_gh_pr_create_passes_with_presence(tmp_path):
    assert run_hook(HOOK, bash("gh pr create --fill"), present(tmp_path)).returncode == 0


def test_untriggered_command_passes_without_presence(tmp_path):
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    assert run_hook(HOOK, bash("git status"), env).returncode == 0


def test_missing_workspace_blocks(tmp_path):
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash("git commit -m x"), env)
    assert result.returncode == 2
    assert "no problem is claimed" in result.stderr
    assert "tb.hub.register" in result.stderr


def test_unclaimed_problem_blocks(tmp_path):
    seed_problem(tmp_path, WS, assigned_to=None, status="open")
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash("git commit -m x"), env)
    assert result.returncode == 2
    assert "no problem is claimed" in result.stderr


def test_in_progress_without_owner_blocks(tmp_path):
    """Identity is half the check: an ownerless problem names nobody."""
    seed_problem(tmp_path, WS, assigned_to=None, status="in-progress")
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash("git commit -m x"), env)
    assert result.returncode == 2
    assert "no problem is claimed" in result.stderr


def test_empty_owner_string_blocks(tmp_path):
    seed_problem(tmp_path, WS, assigned_to="", status="in-progress")
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    assert run_hook(HOOK, bash("git commit -m x"), env).returncode == 2


def test_assigned_but_not_in_progress_blocks(tmp_path):
    seed_problem(tmp_path, WS, status="resolved")
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    assert run_hook(HOOK, bash("git commit -m x"), env).returncode == 2


def test_stale_workspace_blocks(tmp_path):
    seed_problem(tmp_path, WS, age=STALE)
    seed_channel(tmp_path, WS, age=STALE)
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash("git commit -m x"), env)
    assert result.returncode == 2
    assert "30 minutes" in result.stderr


def test_stale_claim_with_fresh_channel_passes(tmp_path):
    """Liveness may come from either directory -- the claim itself can be old."""
    seed_problem(tmp_path, WS, age=STALE)
    seed_channel(tmp_path, WS, age=0)
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    assert run_hook(HOOK, bash("git commit -m x"), env).returncode == 0


def test_future_mtime_does_not_satisfy_recency(tmp_path):
    seed_problem(tmp_path, WS, age=STALE)
    channel = seed_channel(tmp_path, WS, age=STALE)
    set_age(channel, -(365 * 24 * 3600))
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash("git commit -m x"), env)
    assert result.returncode == 2
    assert "30 minutes" in result.stderr


def test_hatch_allows(tmp_path):
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash("git commit -m x # no-hub: hub server is down"), env)
    assert result.returncode == 0
    assert result.stderr == ""


def test_hatch_inside_a_commit_subject_is_not_an_exemption(tmp_path):
    """Quoted: the token is prose in a message, not a declaration by the author."""
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash('git commit -m "# no-hub: nice try"'), env)
    assert result.returncode == 2


def test_hatch_must_sit_at_the_end_of_the_command(tmp_path):
    """Unquoted but not last: a shell comment excuses its own line, not the next.

    Without the end anchor this is the bypass -- one exempted line at the top
    launders every command under it.
    """
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash("echo hi # no-hub: unrelated\ngit commit -m x"), env)
    assert result.returncode == 2


def test_quoted_mention_is_not_a_trigger(tmp_path):
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    assert run_hook(HOOK, bash('echo "git commit"'), env).returncode == 0


def test_compound_command_is_gated(tmp_path):
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    assert run_hook(HOOK, bash("ls && git commit -m x"), env).returncode == 2


def test_git_global_flags_still_match(tmp_path):
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    result = run_hook(HOOK, bash("git -c user.name=x commit -m y"), env)
    assert result.returncode == 2


def test_malformed_problem_is_not_presence(tmp_path):
    path = seed_problem(tmp_path, WS)
    path.write_text("{not json", encoding="utf-8")
    env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
    assert run_hook(HOOK, bash("git commit -m x"), env).returncode == 2


@pytest.mark.skipif(IS_ROOT, reason="root ignores permission bits")
def test_unreadable_state_fails_closed(tmp_path):
    seed_problem(tmp_path, WS)
    seed_channel(tmp_path, WS)
    problems = workspace_dir(tmp_path, WS) / "problems"
    os.chmod(problems, 0o000)
    try:
        env = hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")
        result = run_hook(HOOK, bash("git commit -m x"), env)
    finally:
        os.chmod(problems, 0o755)
    assert result.returncode == 2
    assert "Failing closed" in result.stderr
    assert "indistinguishable from tampered" in result.stderr

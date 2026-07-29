"""Behaviour of 21_require_thought_receipts.py, probed rather than read."""
import os
import pathlib

import pytest
from conftest import IS_ROOT, bash, hub_env, run_hook, seed_manifest, set_age

HOOK = "21_require_thought_receipts.py"
WS = "ws-alpha"
STALE = 45 * 60


def env_for(tmp_path):
    return hub_env(data_dir=tmp_path, workspace=WS, home=tmp_path / "home")


def test_inert_when_env_unset(tmp_path):
    result = run_hook(HOOK, bash("git commit -m x"), hub_env(home=tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_inert_when_only_data_dir_set(tmp_path):
    result = run_hook(HOOK, bash("git commit -m x"), hub_env(data_dir=tmp_path, home=tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_fresh_manifest_partitioned_passes(tmp_path):
    seed_manifest(tmp_path, partition="2026-07")
    assert run_hook(HOOK, bash("git commit -m x"), env_for(tmp_path)).returncode == 0


def test_fresh_manifest_flat_layout_passes(tmp_path):
    seed_manifest(tmp_path, partition=None)
    assert run_hook(HOOK, bash("git commit -m x"), env_for(tmp_path)).returncode == 0


def test_missing_projects_dir_blocks(tmp_path):
    result = run_hook(HOOK, bash("git commit -m x"), env_for(tmp_path))
    assert result.returncode == 2
    assert "tb.thought" in result.stderr
    assert "decision_frame" in result.stderr
    assert "action_report" in result.stderr


def test_stale_manifest_blocks(tmp_path):
    seed_manifest(tmp_path, age=STALE)
    result = run_hook(HOOK, bash("git commit -m x"), env_for(tmp_path))
    assert result.returncode == 2
    assert "30 minutes" in result.stderr


def test_stale_and_fresh_together_pass(tmp_path):
    seed_manifest(tmp_path, session="old", age=STALE)
    seed_manifest(tmp_path, session="new", age=0)
    assert run_hook(HOOK, bash("git commit -m x"), env_for(tmp_path)).returncode == 0


def test_future_mtime_does_not_satisfy_recency(tmp_path):
    manifest = seed_manifest(tmp_path)
    set_age(manifest, -(365 * 24 * 3600))
    assert run_hook(HOOK, bash("git commit -m x"), env_for(tmp_path)).returncode == 2


def test_thought_file_without_manifest_is_not_a_receipt(tmp_path):
    """`NNN.json` siblings are thoughts; the manifest is what marks a session."""
    session = pathlib.Path(tmp_path) / "projects" / "team-hub" / "sessions" / "2026-07" / "s1"
    session.mkdir(parents=True)
    (session / "001.json").write_text("{}", encoding="utf-8")
    assert run_hook(HOOK, bash("git commit -m x"), env_for(tmp_path)).returncode == 2


def test_gh_pr_create_is_not_gated(tmp_path):
    """Hook 20 covers PR creation; this one asks only about commits."""
    assert run_hook(HOOK, bash("gh pr create --fill"), env_for(tmp_path)).returncode == 0


def test_hatch_allows(tmp_path):
    result = run_hook(HOOK, bash("git commit -m x # no-hub: doc typo"), env_for(tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_hatch_inside_a_commit_subject_is_not_an_exemption(tmp_path):
    result = run_hook(HOOK, bash('git commit -m "# no-hub: nice try"'), env_for(tmp_path))
    assert result.returncode == 2


def test_hatch_must_sit_at_the_end_of_the_command(tmp_path):
    """Unquoted but not last: a shell comment excuses its own line, not the next."""
    result = run_hook(HOOK, bash("echo hi # no-hub: unrelated\ngit commit -m x"), env_for(tmp_path))
    assert result.returncode == 2


def test_quoted_mention_is_not_a_trigger(tmp_path):
    assert run_hook(HOOK, bash('echo "git commit"'), env_for(tmp_path)).returncode == 0


def test_compound_command_is_gated(tmp_path):
    assert run_hook(HOOK, bash("ls && git commit -m x"), env_for(tmp_path)).returncode == 2


def test_git_global_flags_still_match(tmp_path):
    assert run_hook(HOOK, bash("git -c user.name=x commit -m y"), env_for(tmp_path)).returncode == 2


@pytest.mark.skipif(IS_ROOT, reason="root ignores permission bits")
def test_unreadable_projects_dir_fails_closed(tmp_path):
    seed_manifest(tmp_path)
    projects = pathlib.Path(tmp_path) / "projects"
    os.chmod(projects, 0o000)
    try:
        result = run_hook(HOOK, bash("git commit -m x"), env_for(tmp_path))
    finally:
        os.chmod(projects, 0o755)
    assert result.returncode == 2
    assert "Failing closed" in result.stderr
    assert "indistinguishable from tampered" in result.stderr

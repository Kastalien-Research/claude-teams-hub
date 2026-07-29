"""Behaviour of 22_protect_hub_state.py, probed rather than read."""
import pathlib

from conftest import bash, hub_env, run_hook, write

HOOK = "22_protect_hub_state.py"


def env_for(tmp_path, data_dir=True):
    home = pathlib.Path(tmp_path) / "home"
    home.mkdir(exist_ok=True)
    return hub_env(data_dir=tmp_path / "data" if data_dir else None, home=home)


def hub_file(tmp_path, *parts) -> pathlib.Path:
    path = pathlib.Path(tmp_path) / "data" / "hub"
    for part in parts:
        path = path / part
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


# --- file-writing tools -------------------------------------------------------


def test_write_into_hub_is_blocked(tmp_path):
    target = hub_file(tmp_path, "agents.json")
    result = run_hook(HOOK, write(target), env_for(tmp_path))
    assert result.returncode == 2
    assert "tb.hub." in result.stderr


def test_write_deep_inside_hub_is_blocked(tmp_path):
    target = hub_file(tmp_path, "workspaces", "ws-alpha", "problems", "p1.json")
    assert run_hook(HOOK, write(target), env_for(tmp_path)).returncode == 2


def test_dotdot_laundered_path_is_blocked(tmp_path):
    """Laundered through a SIBLING, so no spelling of the path contains `/hub/`.

    A comparison that skipped `.resolve()` would let this through while still
    catching `hub/../hub/x`, whose literal text keeps the guarded prefix.
    """
    (pathlib.Path(tmp_path) / "data" / "hub").mkdir(parents=True)
    (pathlib.Path(tmp_path) / "data" / "projects").mkdir(parents=True)
    target = pathlib.Path(tmp_path) / "data" / "projects" / ".." / "hub" / "agents.json"
    assert run_hook(HOOK, write(target), env_for(tmp_path)).returncode == 2


def test_tilde_spelled_write_is_blocked(tmp_path):
    home = pathlib.Path(tmp_path) / "home"
    (home / ".team-hub" / "hub").mkdir(parents=True)
    env = hub_env(data_dir=home / ".team-hub", home=home)
    assert run_hook(HOOK, write("~/.team-hub/hub/agents.json"), env).returncode == 2


def test_edit_tool_is_blocked(tmp_path):
    target = hub_file(tmp_path, "agents.json")
    assert run_hook(HOOK, write(target, tool="Edit"), env_for(tmp_path)).returncode == 2


def test_notebook_path_is_blocked(tmp_path):
    target = hub_file(tmp_path, "notes.ipynb")
    payload = write(target, tool="NotebookEdit", key="notebook_path")
    assert run_hook(HOOK, payload, env_for(tmp_path)).returncode == 2


def test_write_elsewhere_is_allowed(tmp_path):
    target = pathlib.Path(tmp_path) / "data" / "projects" / "p" / "manifest.json"
    target.parent.mkdir(parents=True)
    result = run_hook(HOOK, write(target), env_for(tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_sibling_prefix_is_not_the_hub(tmp_path):
    """`.../hubbub` shares a prefix with `.../hub` and must not be guarded."""
    target = pathlib.Path(tmp_path) / "data" / "hubbub" / "x.json"
    target.parent.mkdir(parents=True)
    assert run_hook(HOOK, write(target), env_for(tmp_path)).returncode == 0


# --- shell commands -----------------------------------------------------------


def test_rm_of_hub_root_is_blocked(tmp_path):
    result = run_hook(HOOK, bash('rm -rf "$HUB_DATA_DIR/hub"'), env_for(tmp_path))
    assert result.returncode == 2
    assert "removing or truncating" in result.stderr


def test_rm_with_absolute_path_is_blocked(tmp_path):
    target = hub_file(tmp_path, "agents.json")
    assert run_hook(HOOK, bash(f"rm -f {target}"), env_for(tmp_path)).returncode == 2


def test_redirect_into_hub_is_blocked(tmp_path):
    command = 'echo "[]" > "$HUB_DATA_DIR/hub/agents.json"'
    result = run_hook(HOOK, bash(command), env_for(tmp_path))
    assert result.returncode == 2
    assert "redirect" in result.stderr


def test_append_redirect_into_hub_is_blocked(tmp_path):
    command = 'echo x >> ${HUB_DATA_DIR}/hub/agents.json'
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 2


def test_sed_in_place_is_blocked(tmp_path):
    command = "sed -i '' s/open/resolved/ \"$HUB_DATA_DIR/hub/workspaces/w/problems/p.json\""
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 2


def test_mv_of_hub_state_is_blocked(tmp_path):
    command = 'mv "$HUB_DATA_DIR/hub/agents.json" /tmp/agents.json'
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 2


def test_git_restore_of_hub_state_is_blocked(tmp_path):
    command = 'git checkout -- "$HUB_DATA_DIR/hub/agents.json"'
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 2


def test_tee_into_hub_is_blocked(tmp_path):
    command = 'echo x | tee "$HUB_DATA_DIR/hub/agents.json"'
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 2


def test_cat_of_hub_state_is_allowed(tmp_path):
    result = run_hook(HOOK, bash('cat "$HUB_DATA_DIR/hub/agents.json"'), env_for(tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_jq_and_grep_reads_are_allowed(tmp_path):
    command = 'jq . "$HUB_DATA_DIR/hub/agents.json" | grep agentId'
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 0


def test_read_piped_out_to_a_file_elsewhere_is_allowed(tmp_path):
    """The redirect target is anchored to the hub, so copying state OUT reads."""
    command = 'cat "$HUB_DATA_DIR/hub/agents.json" > /tmp/copy.json'
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 0


def test_mutator_on_an_unrelated_path_is_allowed(tmp_path):
    assert run_hook(HOOK, bash("rm -rf /tmp/scratch"), env_for(tmp_path)).returncode == 0


def test_sibling_prefix_in_bash_is_not_the_hub(tmp_path):
    """`.../hubbub` starts with `.../hub`; a bare prefix test would block it."""
    result = run_hook(HOOK, bash('rm -rf "$HUB_DATA_DIR/hubbub"'), env_for(tmp_path))
    assert result.returncode == 0
    assert result.stderr == ""


def test_hub_suffixed_filename_is_not_the_hub(tmp_path):
    command = 'rm -f "$HUB_DATA_DIR/hub-backup.tar"'
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 0


def test_compound_command_is_gated_per_segment(tmp_path):
    command = 'ls && rm -f "$HUB_DATA_DIR/hub/agents.json"'
    assert run_hook(HOOK, bash(command), env_for(tmp_path)).returncode == 2


def test_there_is_no_escape_hatch(tmp_path):
    """A trailing `# no-hub:` opts out of hooks 20 and 21, never out of this one."""
    command = 'rm -rf "$HUB_DATA_DIR/hub" # no-hub: I know what I am doing'
    result = run_hook(HOOK, bash(command), env_for(tmp_path))
    assert result.returncode == 2
    assert "no override" in result.stderr


# --- the default store, with HUB_DATA_DIR unset -------------------------------


def test_default_home_store_is_guarded_for_writes(tmp_path):
    home = pathlib.Path(tmp_path) / "home"
    target = home / ".team-hub" / "hub" / "agents.json"
    target.parent.mkdir(parents=True)
    result = run_hook(HOOK, write(target), env_for(tmp_path, data_dir=False))
    assert result.returncode == 2


def test_default_home_store_is_guarded_for_bash(tmp_path):
    home = pathlib.Path(tmp_path) / "home"
    (home / ".team-hub" / "hub").mkdir(parents=True)
    result = run_hook(HOOK, bash("rm -rf ~/.team-hub/hub"), env_for(tmp_path, data_dir=False))
    assert result.returncode == 2


def test_default_store_read_is_allowed(tmp_path):
    home = pathlib.Path(tmp_path) / "home"
    (home / ".team-hub" / "hub").mkdir(parents=True)
    result = run_hook(HOOK, bash("cat ~/.team-hub/hub/agents.json"), env_for(tmp_path, data_dir=False))
    assert result.returncode == 0

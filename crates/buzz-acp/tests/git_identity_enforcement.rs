//! Process-level, mutation-sensitive regression for the deterministic
//! agent-git-identity enforcement wrapper. Unlike the unit tests in
//! `buzz-git-identity`, this exercises the REAL multicall binary: `buzz-acp`
//! symlinked as `git`, invoked exactly as an agent's shell would invoke it,
//! with a `.git-identity` manifest beside the symlink (the harness-owned
//! authority) and the real `git` reachable later on PATH.
//!
//! Each test targets one enforcement layer and is designed to go RED if that
//! layer is deleted:
//!   * `enforce`            — flag-based identity/signing override is rejected.
//!   * `verify_push`        — a human-authored outgoing commit cannot be pushed.
//!   * `apply_authority_env`— the agent identity is re-applied over caller/repo
//!     config (the env-var override vector), so commits land agent-authored
//!     even when repo-local config names a human.

use std::path::{Path, PathBuf};
use std::process::Command;

const AGENT_EMAIL: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@relay.test";

/// Directory of the first real `git` on PATH; the wrapper is installed ahead
/// of it so `find_real_git` skips our shim symlink and reaches this one.
fn real_git_dir() -> PathBuf {
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let cand = dir.join("git");
        if cand.is_file() {
            return dir;
        }
    }
    panic!("no real git on PATH");
}

/// Build a shim dir containing `git` -> the buzz-acp multicall binary and a
/// `.git-identity` manifest, and a PATH with the shim ahead of real git.
/// Returns (shim TempDir, PATH string).
fn shim_env(manifest: &str) -> (tempfile::TempDir, String) {
    let shim = tempfile::tempdir().unwrap();
    let git_link = shim.path().join("git");
    #[cfg(unix)]
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_buzz-acp"), &git_link).unwrap();
    #[cfg(not(unix))]
    std::fs::copy(env!("CARGO_BIN_EXE_buzz-acp"), &git_link).unwrap();

    std::fs::write(shim.path().join(".git-identity"), manifest).unwrap();

    let real = real_git_dir();
    let path = std::env::join_paths([shim.path().to_path_buf(), real])
        .unwrap()
        .into_string()
        .unwrap();
    (shim, path)
}

/// Standard managed manifest with signing OFF (the test box has no nostr
/// signer; signing enforcement is covered by unit tests).
fn manifest() -> String {
    format!("user.name=Agent\nuser.email={AGENT_EMAIL}\ncommit.gpgSign=false\n")
}

/// A git repo with one human-authored commit and human-named local config.
fn human_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let g = |args: &[&str]| {
        let ok = Command::new("git")
            .args(args)
            .current_dir(p)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    };
    g(&["init", "-q", "-b", "main"]);
    g(&["config", "user.name", "Human Dev"]);
    g(&["config", "user.email", "human@example.com"]);
    g(&["config", "commit.gpgSign", "false"]);
    std::fs::write(p.join("f"), "one").unwrap();
    g(&["add", "f"]);
    g(&["commit", "-qm", "human commit"]);
    d
}

/// Invoke the wrapper (`git` on the shim PATH) with `args`, in `cwd`.
fn wrapper(path: &str, cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", path)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .expect("run wrapper git")
}

#[test]
fn wrapper_rejects_flag_based_identity_override() {
    let (_shim, path) = shim_env(&manifest());
    let repo = human_repo();
    std::fs::write(repo.path().join("f"), "two").unwrap();
    wrapper(&path, repo.path(), &["add", "f"]);

    let out = wrapper(
        &path,
        repo.path(),
        &["-c", "user.email=evil@example.com", "commit", "-m", "x"],
    );
    assert!(
        !out.status.success(),
        "override commit should be rejected; stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("machine-managed"),
        "expected the loud enforce message; stderr={}",
        String::from_utf8_lossy(&out.stderr),
    );
}

#[test]
fn wrapper_refuses_to_push_human_authored_commit() {
    let (_shim, path) = shim_env(&manifest());
    let repo = human_repo();
    // A reachable bare remote so the dry-run plan resolves and HEAD (human
    // authored) is examined as an offender.
    let remote = tempfile::tempdir().unwrap();
    assert!(Command::new("git")
        .args(["init", "-q", "--bare", remote.path().to_str().unwrap()])
        .status()
        .unwrap()
        .success());
    wrapper(
        &path,
        repo.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );

    let out = wrapper(&path, repo.path(), &["push", "origin", "main"]);
    assert!(
        !out.status.success(),
        "pushing a human-authored commit must be refused; stderr={}",
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("not authored by your agent identity"),
        "expected the push-gate rejection; stderr={}",
        String::from_utf8_lossy(&out.stderr),
    );
    // The bare remote must have received nothing.
    let refs = Command::new("git")
        .args(["-C", remote.path().to_str().unwrap(), "for-each-ref"])
        .output()
        .unwrap();
    assert!(
        refs.stdout.is_empty(),
        "no ref should have reached the remote: {}",
        String::from_utf8_lossy(&refs.stdout),
    );
}

#[test]
fn wrapper_reapplies_agent_identity_over_repo_config() {
    // The env-var / repo-config override vector: repo-local config names a
    // human, yet the wrapper re-appends the agent identity at the highest
    // GIT_CONFIG_* index, so the resulting commit is agent-authored. Deleting
    // `apply_authority_env` makes this commit land as `human@example.com`.
    let (_shim, path) = shim_env(&manifest());
    let repo = human_repo();
    std::fs::write(repo.path().join("f"), "two").unwrap();
    wrapper(&path, repo.path(), &["add", "f"]);

    let out = wrapper(&path, repo.path(), &["commit", "-m", "agent authored"]);
    assert!(
        out.status.success(),
        "ordinary commit should succeed; stderr={}",
        String::from_utf8_lossy(&out.stderr),
    );

    let author = Command::new("git")
        .args([
            "-C",
            repo.path().to_str().unwrap(),
            "show",
            "-s",
            "--format=%ae",
            "HEAD",
        ])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&author.stdout).trim(),
        AGENT_EMAIL,
        "commit must be authored as the agent identity, not the repo-local human"
    );
}

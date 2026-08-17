//! Enforcement `git` wrapper — the L2/L3 half of deterministic agent identity.
//!
//! Installed on PATH (shim dir and the harness's agent-runtime PATH) as `git`,
//! ahead of the real binary. Every `git` an agent's shell runs lands here first.
//! The wrapper:
//!
//! 1. **Scrubs** `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` and the committer pair from
//!    the child env — the env-var identity-override vector.
//! 2. **Rejects loudly** the flag-based override vectors: `-c user.name=`/
//!    `-c user.email=` (and `--config-env` for the same keys) in global position,
//!    and `--author`/`--reset-author` on `commit`/`am`.
//! 3. On `push`, **verifies** that every outgoing commit not already on a remote
//!    is authored by the agent identity, and fails the push otherwise.
//! 4. Execs the real `git` (found by skipping PATH entries that resolve back to
//!    this binary), so nothing the agent can pass reaches git with a spoofed
//!    identity on the default path.
//!
//! Exit codes: `1` for a rejected override, `1` for a failed push verification,
//! `127` when the real git cannot be found. Otherwise the real git's own status.

use std::path::{Path, PathBuf};

/// Author/committer identity env vars the agent's shell must not use to override
/// the configured Buzz identity. DATE is intentionally left alone — it carries
/// no attribution signal and rebase/cherry-pick rely on it internally.
const SCRUBBED_ENV: &[&str] = &[
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
];

/// Long global options that consume the *following* argv token as their value
/// (the `--opt value` form; the `--opt=value` form is self-contained). Needed
/// only to locate the subcommand correctly; agents almost never pass these.
const VALUE_LONG_OPTS: &[&str] = &[
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--attr-source",
];

/// Entry point for the `git` multicall personality. Never returns on success
/// (execs real git on Unix); returns the process exit code on Windows/error.
pub fn run() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();

    if let Err(msg) = enforce(&argv) {
        eprintln!("{msg}");
        return 1;
    }

    let real_git = match find_real_git() {
        Some(p) => p,
        None => {
            eprintln!(
                "buzz git wrapper: could not locate the real `git` binary on PATH. \
                 Agent git identity enforcement is active but git is not installed."
            );
            return 127;
        }
    };

    // Push verification (L3) runs before exec so a wrongly-authored commit
    // cannot leave the machine. A verification error blocks the push; an
    // *inability to verify* (no agent identity configured) does not.
    if subcommand(&argv).as_deref() == Some("push") {
        if let Err(msg) = verify_push(&real_git, &argv) {
            eprintln!("{msg}");
            return 1;
        }
    }

    exec_real_git(&real_git, &argv)
}

/// Reject the flag-based identity-override vectors. `Ok(())` means the argv is
/// clean and may proceed to the real git.
fn enforce(argv: &[String]) -> Result<(), String> {
    let (globals, sub_idx) = split_globals(argv);

    // `-c user.name=`/`-c user.email=` and `--config-env=user.*` in global
    // position. `-c` only ever appears as a git *global* option, so scanning
    // globals both suffices and avoids misreading `git commit -c <commit>`
    // (reuse-message), where `-c` means something entirely different.
    for token in &globals {
        if let Some(key) = config_key_override(token) {
            return Err(reject_message(&format!("-c {key}=…")));
        }
        if let Some(key) = config_env_override(token) {
            return Err(reject_message(&format!("--config-env={key}=…")));
        }
    }

    // `--author`/`--reset-author` only carry identity for `commit` and `am`.
    // Scoping to those subcommands is load-bearing: `git log --author=…`,
    // `git shortlog --author=…` etc. are legitimate read-side filters that
    // must keep working.
    if let Some(sub) = sub_idx.map(|i| argv[i].as_str()) {
        if sub == "commit" || sub == "am" {
            for token in &argv[sub_idx.unwrap() + 1..] {
                if token == "--author"
                    || token.starts_with("--author=")
                    || token == "--reset-author"
                {
                    return Err(reject_message(token));
                }
            }
        }
    }

    Ok(())
}

fn reject_message(what: &str) -> String {
    format!(
        "buzz git wrapper: refusing `{what}` — agent commit identity is machine-managed \
         and cannot be overridden. Commits are automatically authored as your agent identity \
         (<pubkey>@<relay>). Credit the human operator with `Co-authored-by`/`Signed-off-by` \
         trailers instead."
    )
}

/// If `token` is a `-c <config>` value (attached `-cuser.email=x` or the bare
/// `user.email=x` that follows a standalone `-c`) setting `user.name`/
/// `user.email`, return the normalized key; else `None`.
fn config_key_override(token: &str) -> Option<&'static str> {
    // `-cuser.email=x` attached form, or the standalone value token that
    // `split_globals` already paired with a preceding `-c`.
    let cfg = token
        .strip_prefix("-c")
        .filter(|s| !s.is_empty())
        .unwrap_or(token);
    matches_user_identity_key(cfg)
}

/// If `token` is `--config-env=user.name=VAR` / `--config-env=user.email=VAR`,
/// return the normalized key.
fn config_env_override(token: &str) -> Option<&'static str> {
    let rest = token.strip_prefix("--config-env=")?;
    matches_user_identity_key(rest)
}

/// Normalize a `name.subname[=value]` config spec and return `"user.name"` or
/// `"user.email"` when the key matches (case-insensitive), else `None`.
fn matches_user_identity_key(cfg: &str) -> Option<&'static str> {
    let key = cfg.split('=').next().unwrap_or(cfg).to_ascii_lowercase();
    match key.as_str() {
        "user.name" => Some("user.name"),
        "user.email" => Some("user.email"),
        _ => None,
    }
}

/// Split argv into the global-option tokens (including `-c` values) and the
/// index of the subcommand token, if any. Walks the same value-consuming rules
/// git uses so the subcommand is located correctly.
fn split_globals(argv: &[String]) -> (Vec<String>, Option<usize>) {
    let mut globals = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        if !arg.starts_with('-') {
            return (globals, Some(i)); // first non-option token = subcommand
        }
        globals.push(arg.clone());
        // `-c`/`-C` and the value-taking long options each consume the next
        // token as their value; pull it into globals so the subcommand scan
        // doesn't mistake a value for the subcommand.
        let takes_value = arg == "-c" || arg == "-C" || VALUE_LONG_OPTS.contains(&arg.as_str());
        if takes_value && i + 1 < argv.len() {
            i += 1;
            globals.push(argv[i].clone());
        }
        i += 1;
    }
    (globals, None)
}

/// The git subcommand (first non-option token), or `None` for a bare `git` /
/// `git --version`-style invocation.
fn subcommand(argv: &[String]) -> Option<String> {
    let (_, idx) = split_globals(argv);
    idx.map(|i| argv[i].clone())
}

/// Verify that every commit being pushed that is not already on a remote is
/// authored by the agent identity. `Ok(())` allows the push.
///
/// Scope guard against false positives: `rev-list <tip> --not --remotes` yields
/// only commits absent from every remote-tracking ref, so pre-existing human
/// commits pulled in via a merge/rebase of `main` are excluded — they are
/// reachable from `refs/remotes/*`. Only genuinely new local ("session")
/// commits are checked, which is exactly the set that should be agent-authored.
fn verify_push(real_git: &Path, argv: &[String]) -> Result<(), String> {
    // The expected identity is whatever git config resolves `user.email` to —
    // i.e. the injected agent identity. If it does not look like an agent email
    // (`<64-hex>@host`), we cannot determine the agent identity and must not
    // block (avoids false rejects in unconfigured/local sessions).
    let expected = git_config_email(real_git);
    let expected = match expected {
        Some(e) if is_agent_email(&e) => e,
        _ => return Ok(()),
    };

    let mut offenders = Vec::new();
    for tip in push_source_revs(argv) {
        let shas = match rev_list_outgoing(real_git, &tip) {
            Some(s) => s,
            None => continue, // unresolvable ref (e.g. deletion) — nothing to check
        };
        for sha in shas {
            if let Some(email) = commit_author_email(real_git, &sha) {
                if email != expected {
                    offenders.push((sha, email));
                }
            }
        }
    }

    if offenders.is_empty() {
        return Ok(());
    }
    let mut msg = String::from(
        "buzz git wrapper: refusing to push — these outgoing commits are not authored \
         by your agent identity (expected author email ",
    );
    msg.push_str(&expected);
    msg.push_str("):\n");
    for (sha, email) in &offenders {
        msg.push_str(&format!(
            "  {} authored by {}\n",
            &sha[..sha.len().min(12)],
            email
        ));
    }
    msg.push_str(
        "Re-author them as your agent identity (e.g. `git rebase` with `--reset-author`-free \
         re-commits under the managed identity) before pushing.",
    );
    Err(msg)
}

/// Whether an email has the `<64-lowercase-hex>@host` shape of an agent identity.
fn is_agent_email(email: &str) -> bool {
    match email.split_once('@') {
        Some((local, host)) => {
            local.len() == 64 && local.bytes().all(|b| b.is_ascii_hexdigit()) && !host.is_empty()
        }
        None => false,
    }
}

/// Resolve the local source revisions a `git push` will send. Options are
/// skipped; the first positional is the remote, the rest are refspecs whose
/// *source* (left of `:`) is the local rev. With no refspec, the push sends the
/// current branch, so `HEAD` is used. Deletion refspecs (empty source) and
/// `--delete` contribute nothing.
fn push_source_revs(argv: &[String]) -> Vec<String> {
    // argv[0..] here is everything after `git`; drop globals + the `push` token.
    let (_, sub_idx) = split_globals(argv);
    let after = match sub_idx {
        Some(i) => &argv[i + 1..],
        None => return vec!["HEAD".into()],
    };

    let mut positionals = Vec::new();
    let mut is_delete = false;
    let mut opt_takes_value = false;
    for arg in after {
        if opt_takes_value {
            opt_takes_value = false;
            continue;
        }
        if arg == "--delete" || arg == "-d" {
            is_delete = true;
        } else if arg.starts_with('-') {
            // `--repo <name>` and `-o/--push-option <v>` take a following value;
            // conservatively treat known ones. Others are boolean flags.
            if arg == "--repo" || arg == "-o" || arg == "--push-option" {
                opt_takes_value = true;
            }
        } else {
            positionals.push(arg.clone());
        }
    }

    if is_delete {
        return Vec::new();
    }
    // positionals[0] is the remote; the rest are refspecs.
    let refspecs = positionals.get(1..).unwrap_or(&[]);
    if refspecs.is_empty() {
        return vec!["HEAD".into()];
    }
    refspecs
        .iter()
        .filter_map(|spec| {
            let src = spec.split(':').next().unwrap_or(spec);
            let src = src.strip_prefix('+').unwrap_or(src); // force marker
            (!src.is_empty()).then(|| src.to_string())
        })
        .collect()
}

fn git_config_email(real_git: &Path) -> Option<String> {
    capture(real_git, &["config", "--get", "user.email"])
}

fn commit_author_email(real_git: &Path, sha: &str) -> Option<String> {
    capture(real_git, &["show", "-s", "--format=%ae", sha])
}

/// Commits reachable from `tip` but not from any remote-tracking ref. `None`
/// when `tip` does not resolve (rev-list exits non-zero).
fn rev_list_outgoing(real_git: &Path, tip: &str) -> Option<Vec<String>> {
    let out = capture_output(real_git, &["rev-list", tip, "--not", "--remotes"])?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect(),
    )
}

fn capture(real_git: &Path, args: &[&str]) -> Option<String> {
    let out = capture_output(real_git, args)?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn capture_output(real_git: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut cmd = std::process::Command::new(real_git);
    cmd.args(args);
    scrub_env(&mut cmd);
    cmd.output().ok()
}

fn scrub_env(cmd: &mut std::process::Command) {
    for var in SCRUBBED_ENV {
        cmd.env_remove(var);
    }
}

/// Locate the real `git`: the first PATH entry whose `git` does not resolve back
/// to this binary (the wrapper symlink). Canonicalization defeats the symlink so
/// we never exec ourselves.
fn find_real_git() -> Option<PathBuf> {
    let self_canon = std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok());
    let git_name = if cfg!(windows) { "git.exe" } else { "git" };

    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = dir.join(git_name);
        if !candidate.is_file() {
            continue;
        }
        let cand_canon = candidate.canonicalize().ok();
        if cand_canon.is_some() && cand_canon == self_canon {
            continue; // this is our own wrapper symlink
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = std::fs::metadata(&candidate)
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if !executable {
                continue;
            }
        }
        return Some(candidate);
    }
    None
}

#[cfg(unix)]
fn exec_real_git(real_git: &Path, argv: &[String]) -> i32 {
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(real_git);
    cmd.args(argv);
    scrub_env(&mut cmd);
    // exec replaces this process; on success it never returns. If it returns,
    // the exec itself failed.
    let err = cmd.exec();
    eprintln!("buzz git wrapper: failed to exec real git: {err}");
    127
}

#[cfg(not(unix))]
fn exec_real_git(real_git: &Path, argv: &[String]) -> i32 {
    let mut cmd = std::process::Command::new(real_git);
    cmd.args(argv);
    scrub_env(&mut cmd);
    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("buzz git wrapper: failed to run real git: {e}");
            127
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    // ── enforce: -c user.* rejection ──────────────────────────────────────────

    #[test]
    fn rejects_dash_c_user_name_and_email_in_global_position() {
        for argv in [
            v(&["-c", "user.name=Evil", "commit"]),
            v(&["-c", "user.email=evil@x.com", "commit"]),
            v(&["-cuser.name=Evil", "commit"]), // attached form
            v(&["-cuser.email=e@x", "commit"]), // attached form
            v(&["-c", "USER.EMAIL=e@x", "commit"]), // case-insensitive key
        ] {
            assert!(enforce(&argv).is_err(), "must reject {argv:?}");
        }
    }

    #[test]
    fn allows_dash_c_for_unrelated_config_keys() {
        for argv in [
            v(&["-c", "core.pager=less", "log"]),
            v(&["-c", "commit.gpgSign=false", "commit"]),
            v(&["-c", "user.signingkey=abc", "commit"]),
        ] {
            assert!(enforce(&argv).is_ok(), "must allow {argv:?}");
        }
    }

    #[test]
    fn commit_dash_c_reuse_message_is_not_a_config_override() {
        // `git commit -c <commit>` reuses a message; `-c` here is a commit
        // option, not the global config flag. It must not be misread as one.
        assert!(enforce(&v(&["commit", "-c", "HEAD~1"])).is_ok());
        assert!(enforce(&v(&["commit", "-cuser.name=x"])).is_ok());
    }

    // ── enforce: --config-env rejection ───────────────────────────────────────

    #[test]
    fn rejects_config_env_for_user_identity_keys() {
        assert!(enforce(&v(&["--config-env=user.name=VAR", "commit"])).is_err());
        assert!(enforce(&v(&["--config-env=user.email=VAR", "commit"])).is_err());
    }

    #[test]
    fn allows_config_env_for_unrelated_keys() {
        assert!(enforce(&v(&["--config-env=http.proxy=PROXY", "fetch"])).is_ok());
    }

    // ── enforce: --author / --reset-author scoping ────────────────────────────

    #[test]
    fn rejects_author_overrides_on_commit_and_am() {
        for argv in [
            v(&["commit", "--author=Evil <e@x>"]),
            v(&["commit", "--author", "Evil <e@x>"]),
            v(&["commit", "--reset-author"]),
            v(&["am", "--author=Evil <e@x>"]),
        ] {
            assert!(enforce(&argv).is_err(), "must reject {argv:?}");
        }
    }

    #[test]
    fn allows_author_filter_on_read_side_subcommands() {
        // log/shortlog/blame --author are legitimate read filters.
        for argv in [
            v(&["log", "--author=Duncan"]),
            v(&["shortlog", "--author", "Duncan"]),
            v(&["log", "--author=x", "--reset-author"]), // not commit/am → not identity
        ] {
            assert!(enforce(&argv).is_ok(), "must allow {argv:?}");
        }
    }

    #[test]
    fn author_override_after_global_options_is_still_rejected() {
        assert!(enforce(&v(&["-C", "/repo", "commit", "--author=Evil <e@x>"])).is_err());
    }

    // ── split_globals / subcommand ────────────────────────────────────────────

    #[test]
    fn split_globals_locates_subcommand_after_value_consuming_options() {
        assert_eq!(subcommand(&v(&["commit"])).as_deref(), Some("commit"));
        assert_eq!(
            subcommand(&v(&["-C", "/repo", "-c", "core.x=y", "push"])).as_deref(),
            Some("push")
        );
        assert_eq!(
            subcommand(&v(&["--git-dir", "/g", "status"])).as_deref(),
            Some("status")
        );
        assert_eq!(subcommand(&v(&["--version"])), None);
        assert_eq!(subcommand(&[]), None);
    }

    // ── is_agent_email ────────────────────────────────────────────────────────

    #[test]
    fn agent_email_requires_64_hex_local_and_a_host() {
        let hex = "a".repeat(64);
        assert!(is_agent_email(&format!("{hex}@relay.example.com")));
        assert!(is_agent_email(&format!("{hex}@buzz")));
        // Wrong length, non-hex, or missing host → not an agent email.
        assert!(!is_agent_email(&format!("{}@x", "a".repeat(63))));
        assert!(!is_agent_email(&format!("{}@x", "a".repeat(65))));
        assert!(!is_agent_email(&format!("{}@x", "g".repeat(64))));
        assert!(!is_agent_email(&format!("{hex}@")));
        assert!(!is_agent_email("will@example.com"));
        assert!(!is_agent_email("no-at-sign"));
    }

    // ── push_source_revs ──────────────────────────────────────────────────────

    #[test]
    fn push_with_no_refspec_checks_head() {
        assert_eq!(push_source_revs(&v(&["push"])), vec!["HEAD"]);
        assert_eq!(push_source_revs(&v(&["push", "origin"])), vec!["HEAD"]);
    }

    #[test]
    fn push_refspec_source_is_left_of_colon_with_force_marker_stripped() {
        assert_eq!(
            push_source_revs(&v(&["push", "origin", "mybranch:main"])),
            vec!["mybranch"]
        );
        assert_eq!(
            push_source_revs(&v(&["push", "origin", "+feature:main"])),
            vec!["feature"]
        );
        assert_eq!(
            push_source_revs(&v(&["push", "origin", "HEAD:main", "tagx:tagx"])),
            vec!["HEAD", "tagx"]
        );
    }

    #[test]
    fn push_deletion_refspecs_contribute_no_source() {
        // `--delete` and empty-source `:branch` are deletions — nothing to verify.
        assert!(push_source_revs(&v(&["push", "origin", "--delete", "old"])).is_empty());
        assert_eq!(
            push_source_revs(&v(&["push", "origin", ":old"])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn push_skips_value_taking_options_when_finding_positionals() {
        // `--repo <name>` value must not be mistaken for the remote/refspec.
        assert_eq!(
            push_source_revs(&v(&["push", "--repo", "myrepo", "origin", "b:main"])),
            vec!["b"]
        );
        // Boolean flags are ignored.
        assert_eq!(
            push_source_revs(&v(&["push", "--force", "origin", "b:main"])),
            vec!["b"]
        );
    }
}

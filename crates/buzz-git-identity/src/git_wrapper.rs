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
    // cannot leave the machine. The effective command is resolved through git
    // aliases (config-defined and inline `-c alias.*`), because `git pub` with
    // `alias.pub = push` reaches the real push after we hand off — keying on the
    // literal token alone would let an alias slip a wrong-authored commit past.
    let ctx = repo_context_args(&argv);
    if is_push_command(&real_git, &argv, &ctx) {
        if let Err(msg) = verify_push(&real_git, &argv, &ctx) {
            eprintln!("{msg}");
            return 1;
        }
    }

    exec_real_git(&real_git, &argv)
}

/// Global options that carry the repository context real git would apply. The
/// verifier's internal `config`/`rev-list`/`show` probes must run under the
/// same context or they resolve against the wrapper's cwd instead — the
/// `git -C <repo> push` bypass. `-C` and its value are already paired into the
/// globals by [`split_globals`].
fn repo_context_args(argv: &[String]) -> Vec<String> {
    let (globals, _) = split_globals(argv);
    let mut ctx = Vec::new();
    let mut i = 0;
    while i < globals.len() {
        let g = globals[i].as_str();
        if matches!(g, "-C" | "--git-dir" | "--work-tree" | "--namespace") {
            ctx.push(globals[i].clone());
            if i + 1 < globals.len() {
                i += 1;
                ctx.push(globals[i].clone());
            }
        } else if g.starts_with("--git-dir=")
            || g.starts_with("--work-tree=")
            || g.starts_with("--namespace=")
        {
            ctx.push(globals[i].clone());
        }
        i += 1;
    }
    ctx
}

/// Whether the invocation's *effective* command is `push`, resolving git
/// aliases so `git pub` (with `alias.pub = push`) and `git -c alias.pub=push
/// pub` are both recognized. Config aliases are read under `ctx` so a
/// `-C <repo>` push consults the target repo's aliases. Shell aliases (`!…`)
/// are opaque to arg parsing, so an alias body that invokes `push` is treated
/// as a push (over-verification only ever rejects wrong-authored commits, never
/// legitimate ones). Recursion is bounded to defeat cyclic alias definitions.
fn is_push_command(real_git: &Path, argv: &[String], ctx: &[String]) -> bool {
    let (globals, _) = split_globals(argv);
    let inline = inline_aliases(&globals);
    let mut name = match subcommand(argv) {
        Some(s) => s,
        None => return false,
    };
    for _ in 0..10 {
        if name == "push" {
            return true;
        }
        let def = inline.get(&name).cloned().or_else(|| {
            capture(
                real_git,
                ctx,
                &["config", "--get", &format!("alias.{name}")],
            )
        });
        let def = match def {
            Some(d) => d,
            None => return false, // not an alias — this is the effective command
        };
        if let Some(body) = def.strip_prefix('!') {
            // Shell alias: opaque; verify if its body invokes push anywhere.
            return body
                .split_whitespace()
                .any(|t| t == "push" || t.ends_with("/git-push"));
        }
        match def.split_whitespace().next() {
            Some(first) => name = first.to_string(),
            None => return false,
        }
    }
    false
}

/// Map of inline `-c alias.NAME=BODY` definitions passed on the command line.
/// These win over config-file aliases, matching git's own precedence.
fn inline_aliases(globals: &[String]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for token in globals {
        let cfg = token
            .strip_prefix("-c")
            .filter(|s| !s.is_empty())
            .unwrap_or(token);
        if let Some(rest) = cfg.strip_prefix("alias.") {
            if let Some((name, body)) = rest.split_once('=') {
                map.insert(name.to_string(), body.to_string());
            }
        }
    }
    map
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
fn verify_push(real_git: &Path, argv: &[String], ctx: &[String]) -> Result<(), String> {
    // The expected identity is whatever git config resolves `user.email` to —
    // i.e. the injected agent identity. If it does not look like an agent email
    // (`<64-hex>@host`), we cannot determine the agent identity and must not
    // block (avoids false rejects in unconfigured/local sessions).
    let expected = git_config_email(real_git, ctx);
    let expected = match expected {
        Some(e) if is_agent_email(&e) => e,
        _ => return Ok(()),
    };

    let mut offenders = Vec::new();
    for tip in push_source_revs(argv) {
        let shas = match rev_list_outgoing(real_git, ctx, &tip) {
            Some(s) => s,
            // Fail closed: an outgoing tip that resolves to a real ref but whose
            // range we cannot compute must not be treated as "nothing to check"
            // — that was the `-C <repo>` bypass. Only genuinely unresolvable
            // refs (deletions, tag-only pushes) skip, distinguished below.
            None => {
                if ref_exists(real_git, ctx, &tip) {
                    return Err(format!(
                        "buzz git wrapper: refusing to push — could not verify the authorship of \
                         outgoing commits for `{tip}`. Enforcement fails closed rather than let \
                         an unverified commit leave the machine."
                    ));
                }
                continue;
            }
        };
        for sha in shas {
            if let Some(email) = commit_author_email(real_git, ctx, &sha) {
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

fn git_config_email(real_git: &Path, ctx: &[String]) -> Option<String> {
    capture(real_git, ctx, &["config", "--get", "user.email"])
}

fn commit_author_email(real_git: &Path, ctx: &[String], sha: &str) -> Option<String> {
    capture(real_git, ctx, &["show", "-s", "--format=%ae", sha])
}

/// Whether `tip` resolves to a real object/ref under `ctx`. Distinguishes a
/// genuinely-absent ref (deletion, nonexistent source — safe to skip) from a
/// ref that exists but whose outgoing range could not be computed (fail closed).
fn ref_exists(real_git: &Path, ctx: &[String], tip: &str) -> bool {
    let mut args = ctx.to_vec();
    args.extend(
        [
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{tip}^{{commit}}"),
        ]
        .map(String::from),
    );
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    capture_raw(real_git, &arg_refs)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Commits reachable from `tip` but not from any remote-tracking ref. `None`
/// when `tip` does not resolve (rev-list exits non-zero).
fn rev_list_outgoing(real_git: &Path, ctx: &[String], tip: &str) -> Option<Vec<String>> {
    let mut args = ctx.to_vec();
    args.extend(["rev-list", tip, "--not", "--remotes"].map(String::from));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = capture_raw(real_git, &arg_refs)?;
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

/// Run `git <ctx...> <args...>` and capture trimmed stdout when it succeeds.
/// `ctx` carries repository-context globals (`-C`, `--git-dir`, …) so the probe
/// resolves against the same repository the user's command targets.
fn capture(real_git: &Path, ctx: &[String], args: &[&str]) -> Option<String> {
    let mut full = ctx.to_vec();
    full.extend(args.iter().map(|s| s.to_string()));
    let arg_refs: Vec<&str> = full.iter().map(String::as_str).collect();
    let out = capture_raw(real_git, &arg_refs)?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn capture_raw(real_git: &Path, args: &[&str]) -> Option<std::process::Output> {
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

    // ── inline_aliases / repo_context_args ────────────────────────────────────

    #[test]
    fn inline_aliases_parses_dash_c_alias_definitions() {
        let (globals, _) = split_globals(&v(&["-c", "alias.pub=push", "-calias.p=push", "pub"]));
        let map = inline_aliases(&globals);
        assert_eq!(map.get("pub").map(String::as_str), Some("push"));
        assert_eq!(map.get("p").map(String::as_str), Some("push"));
    }

    #[test]
    fn repo_context_args_extracts_repository_context_globals() {
        assert_eq!(
            repo_context_args(&v(&["-C", "/repo", "-c", "core.x=y", "push"])),
            v(&["-C", "/repo"])
        );
        assert_eq!(
            repo_context_args(&v(&["--git-dir=/g", "status"])),
            v(&["--git-dir=/g"])
        );
        assert!(repo_context_args(&v(&["push"])).is_empty());
    }

    // ── is_push_command / verify_push against a real git repo ─────────────────

    /// Build a repo whose HEAD carries a deliberately human-authored commit and
    /// return `(tempdir, repo_path)`. No remote, so `--not --remotes` yields the
    /// full history — the commit shows as outgoing.
    fn human_authored_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_path_buf();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Human"]);
        git(&["config", "user.email", "human@example.com"]);
        git(&["config", "commit.gpgSign", "false"]);
        git(&["config", "alias.pub", "push"]);
        std::fs::write(repo.join("f"), "x").unwrap();
        git(&["add", "f"]);
        git(&["commit", "-qm", "human commit"]);
        (dir, repo)
    }

    fn real_git() -> PathBuf {
        PathBuf::from("git")
    }

    #[test]
    fn config_alias_resolving_to_push_is_recognized() {
        let (_d, repo) = human_authored_repo();
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        // `git pub` → alias.pub = push.
        assert!(is_push_command(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "pub"]),
            &ctx
        ));
        // A non-push subcommand is not misclassified.
        assert!(!is_push_command(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "status"]),
            &ctx
        ));
    }

    #[test]
    fn inline_alias_resolving_to_push_is_recognized() {
        let ctx: Vec<String> = vec![];
        assert!(is_push_command(
            &real_git(),
            &v(&["-c", "alias.pub=push", "pub"]),
            &ctx
        ));
    }

    #[test]
    fn verify_push_rejects_human_commit_through_dash_c_context() {
        let (_d, repo) = human_authored_repo();
        let agent = format!("{}@relay.test", "a".repeat(64));
        // Point the agent identity at a different email so HEAD is an offender.
        std::process::Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "config", "user.email", &agent])
            .status()
            .unwrap();
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        let err = verify_push(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "push", "origin", "main"]),
            &ctx,
        )
        .expect_err("human-authored HEAD must be refused");
        assert!(err.contains("not authored by your agent identity"), "{err}");
    }

    #[test]
    fn ref_exists_distinguishes_real_refs_from_absent_ones() {
        // Fail-closed hinges on this: a tip that resolves to a real commit but
        // whose outgoing range can't be computed is refused, while a genuinely
        // absent ref (deletion) is safely skipped.
        let (_d, repo) = human_authored_repo();
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        assert!(ref_exists(&real_git(), &ctx, "main"));
        assert!(ref_exists(&real_git(), &ctx, "HEAD"));
        assert!(!ref_exists(&real_git(), &ctx, "no-such-ref"));
    }
}

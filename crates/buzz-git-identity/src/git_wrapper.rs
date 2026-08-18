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

/// The harness-owned identity authority: the identity/signing config the
/// wrapper re-applies before exec, and the agent author email push
/// verification checks against. Read from the 0600 manifest the harness/shim
/// wrote beside the keyfile — never from the caller-mutable `GIT_CONFIG_*`
/// environment the wrapper exists to constrain.
struct Authority {
    /// Ordered identity + signing `(key, value)` git config entries.
    entries: Vec<(String, String)>,
    /// The expected commit author email (`<64-hex>@host`).
    email: String,
}

/// Result of locating the wrapper's identity authority.
enum AuthorityState {
    /// The wrapper was not reached through an install symlink on `PATH`, so its
    /// own dir (and any manifest) cannot be located. This is the accepted local
    /// ceiling — e.g. the real `git` invoked by absolute path — so there is no
    /// authority to enforce against: passthrough.
    Unmanaged,
    /// The install dir is located and holds a valid manifest: enforce.
    Managed(Authority),
    /// The install dir is located but its manifest is missing, empty, or lacks
    /// a usable `user.email`. A managed install always writes a valid manifest,
    /// so this means the authority was deleted or corrupted after install —
    /// fail closed rather than silently drop enforcement.
    Tampered,
}

impl Authority {
    /// Locate and classify the wrapper's identity authority. Distinguishing a
    /// genuinely unmanaged wrapper (no install dir on `PATH`) from a located
    /// install dir whose manifest was removed/corrupted is load-bearing: the
    /// former passes through (accepted ceiling), the latter fails closed.
    fn load() -> AuthorityState {
        let Some(dir) = locate_install_dir() else {
            return AuthorityState::Unmanaged;
        };
        let Some(entries) = crate::read_identity_manifest(&dir) else {
            return AuthorityState::Tampered; // manifest missing/unreadable
        };
        let Some(email) = entries
            .iter()
            .find(|(k, _)| k == "user.email")
            .map(|(_, v)| v.clone())
        else {
            return AuthorityState::Tampered; // present but no usable identity
        };
        AuthorityState::Managed(Self { entries, email })
    }
}

/// Entry point for the `git` multicall personality. Never returns on success
/// (execs real git on Unix); returns the process exit code on Windows/error.
pub fn run() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();

    // Classify the authority. `Tampered` (install dir located but manifest
    // missing/corrupt) fails closed for every command: a managed install always
    // writes a valid manifest, so its absence means the authority was removed or
    // damaged after install, and continuing would silently drop enforcement.
    let authority = match Authority::load() {
        AuthorityState::Managed(a) => Some(a),
        AuthorityState::Unmanaged => None,
        AuthorityState::Tampered => {
            eprintln!(
                "buzz git wrapper: refusing to run — this `git` is a managed enforcement \
                 wrapper but its identity manifest is missing or unreadable. Enforcement fails \
                 closed rather than fall back to an ambient identity."
            );
            return 1;
        }
    };

    if let Err(msg) = enforce(&argv, authority.as_ref()) {
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

    let ctx = repo_context_args(&argv);

    // Author preflight (E): commit modes that reuse or preserve another author
    // (`-C`/`-c <sha>`, `--amend`) create NEW commits stamped with that author.
    // Re-applied identity config cannot fix this — git honours the reused
    // author — so reject when the resulting author would not be the agent.
    if let Some(auth) = &authority {
        if let Err(msg) = verify_commit_author(&real_git, &argv, &ctx, auth) {
            eprintln!("{msg}");
            return 1;
        }
    }

    // Push verification (L3) runs before exec so a wrongly-authored commit
    // cannot leave the machine. The effective command is resolved through git
    // aliases (config-defined and inline `-c alias.*`), because `git pub` with
    // `alias.pub = push` reaches the real push after we hand off — keying on the
    // literal token alone would let an alias slip a wrong-authored commit past.
    if let Some(auth) = &authority {
        match is_push_command(&real_git, &argv, &ctx) {
            PushKind::NotPush => {}
            PushKind::Push => {
                if let Err(msg) = verify_push(&real_git, &argv, &ctx, auth) {
                    eprintln!("{msg}");
                    return 1;
                }
            }
            // A shell (`!`) alias whose body may push is opaque: we cannot
            // resolve its transport plan without executing arbitrary shell code,
            // and executing it as a probe would let it transmit before
            // verification. Reject loudly rather than run it.
            PushKind::OpaqueShellAlias(name) => {
                eprintln!(
                    "buzz git wrapper: refusing `{name}` — it is a shell (`!`) alias whose \
                     effective command may push, and its outgoing commits cannot be verified \
                     without executing it. Run the underlying `git push` directly so agent \
                     authorship can be checked."
                );
                return 1;
            }
        }
    }

    exec_real_git(&real_git, &argv, authority.as_ref())
}

/// The wrapper's own install dir: the first `PATH` entry whose `git` resolves
/// (through the install symlink) back to this binary. That dir holds the 0600
/// identity manifest and keyfile. Located by canonicalization — the same
/// env-independent trust channel as [`find_real_git`] — so an agent cannot
/// point the wrapper at a forged authority by rewriting environment variables.
fn locate_install_dir() -> Option<PathBuf> {
    let self_canon = std::env::current_exe().ok()?.canonicalize().ok()?;
    let git_name = if cfg!(windows) { "git.exe" } else { "git" };
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = dir.join(git_name);
        if candidate.canonicalize().ok().as_ref() == Some(&self_canon) {
            return Some(dir);
        }
    }
    None
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

/// The effective-command classification of an invocation.
enum PushKind {
    /// The effective command is not `push`.
    NotPush,
    /// The effective command resolves to `push` through ordinary (config/inline)
    /// git aliases; its transport plan can be resolved safely with `--dry-run`.
    Push,
    /// The effective command is a shell (`!`) alias whose body may push. Its
    /// plan cannot be resolved without executing arbitrary shell code, so it is
    /// rejected rather than probed. Carries the alias name for the message.
    OpaqueShellAlias(String),
}

/// Classify the invocation's *effective* command, resolving ordinary git
/// aliases so `git pub` (with `alias.pub = push`) and `git -c alias.pub=push
/// pub` are both recognized. Config aliases are read under `ctx` so a
/// `-C <repo>` push consults the target repo's aliases.
///
/// Shell aliases (`!…`) are NOT expanded into a plan: resolving their transport
/// would require running the shell body, and the dry-run probe would let that
/// body transmit before verification. A shell alias whose body invokes `push`
/// is returned as [`PushKind::OpaqueShellAlias`] and rejected by the caller.
/// Recursion is bounded to defeat cyclic alias definitions.
fn is_push_command(real_git: &Path, argv: &[String], ctx: &[String]) -> PushKind {
    let (globals, _) = split_globals(argv);
    let inline = inline_aliases(&globals);
    let mut name = match subcommand(argv) {
        Some(s) => s,
        None => return PushKind::NotPush,
    };
    for _ in 0..10 {
        if name == "push" {
            return PushKind::Push;
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
            None => return PushKind::NotPush, // not an alias — effective command
        };
        if let Some(body) = def.strip_prefix('!') {
            // Shell alias: opaque. If its body may push, reject (never probe it).
            let may_push = body
                .split_whitespace()
                .any(|t| t == "push" || t.ends_with("/git-push"));
            return if may_push {
                PushKind::OpaqueShellAlias(name)
            } else {
                PushKind::NotPush
            };
        }
        match def.split_whitespace().next() {
            Some(first) => name = first.to_string(),
            None => return PushKind::NotPush,
        }
    }
    PushKind::NotPush
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

/// Reject the flag-based identity- and signing-override vectors. `Ok(())` means
/// the argv is clean and may proceed to the real git.
///
/// Only enforces in a managed session (`authority` present): an unmanaged
/// session has no injected identity or signing config to protect, so rejecting
/// `--no-gpg-sign` there would break ordinary use. The env-var forms of these
/// overrides (`GIT_CONFIG_*`) are defeated separately by re-applying the
/// authoritative config at the highest index before exec; this covers the
/// command-line forms, which win over env config and so must be refused.
fn enforce(argv: &[String], authority: Option<&Authority>) -> Result<(), String> {
    if authority.is_none() {
        return Ok(());
    }
    let (globals, sub_idx) = split_globals(argv);

    // Protected config keys set via `-c key=…`/`-ckey=…` or `--config-env=key=VAR`
    // in global position. `-c` only ever appears as a git *global* option, so
    // scanning globals both suffices and avoids misreading `git commit -c
    // <commit>` (reuse-message), where `-c` means something entirely different.
    for token in &globals {
        if let Some(key) = config_key_override(token) {
            return Err(reject_message(&format!("-c {key}=…")));
        }
        if let Some(key) = config_env_override(token) {
            return Err(reject_message(&format!("--config-env={key}=…")));
        }
    }

    // Subcommand-scoped identity/signing flags. `--author`/`--reset-author`
    // carry identity for `commit`/`am`; `--no-gpg-sign` disables the signing
    // the harness lifted. Scoping to the relevant subcommands is load-bearing:
    // `git log --author=…` is a legitimate read filter that must keep working.
    if let Some(sub) = sub_idx.map(|i| argv[i].as_str()) {
        let is_commit_or_am = sub == "commit" || sub == "am";
        let signs = matches!(
            sub,
            "commit" | "am" | "tag" | "rebase" | "cherry-pick" | "revert"
        );
        for token in &argv[sub_idx.unwrap() + 1..] {
            if is_commit_or_am
                && (token == "--author"
                    || token.starts_with("--author=")
                    || token == "--reset-author")
            {
                return Err(reject_message(token));
            }
            if signs && token == "--no-gpg-sign" {
                return Err(reject_message(token));
            }
        }
    }

    Ok(())
}

fn reject_message(what: &str) -> String {
    format!(
        "buzz git wrapper: refusing `{what}` — agent commit identity and signing are \
         machine-managed and cannot be overridden. Commits are automatically authored as your \
         agent identity (<pubkey>@<relay>) and signed. Credit the human operator with \
         `Co-authored-by`/`Signed-off-by` trailers instead."
    )
}

/// If `token` is a `-c <config>` value (attached `-cuser.email=x` or the bare
/// `user.email=x` that follows a standalone `-c`) setting a protected identity
/// or signing key, return the normalized key; else `None`.
fn config_key_override(token: &str) -> Option<&'static str> {
    // `-cuser.email=x` attached form, or the standalone value token that
    // `split_globals` already paired with a preceding `-c`.
    let cfg = token
        .strip_prefix("-c")
        .filter(|s| !s.is_empty())
        .unwrap_or(token);
    matches_protected_key(cfg)
}

/// If `token` is `--config-env=<key>=VAR` for a protected key, return it.
fn config_env_override(token: &str) -> Option<&'static str> {
    let rest = token.strip_prefix("--config-env=")?;
    matches_protected_key(rest)
}

/// Normalize a `name.subname[=value]` config spec and return the canonical key
/// when it names a protected identity or signing setting (case-insensitive).
/// These are exactly the keys [`crate::identity_signing_entries`] injects: an
/// agent must not be able to redirect authorship or disable/redirect signing.
fn matches_protected_key(cfg: &str) -> Option<&'static str> {
    let key = cfg.split('=').next().unwrap_or(cfg).to_ascii_lowercase();
    match key.as_str() {
        "user.name" => Some("user.name"),
        "user.email" => Some("user.email"),
        "user.signingkey" => Some("user.signingkey"),
        "commit.gpgsign" => Some("commit.gpgSign"),
        "tag.gpgsign" => Some("tag.gpgSign"),
        "gpg.format" => Some("gpg.format"),
        "gpg.x509.program" => Some("gpg.x509.program"),
        "nostr.keyfile" => Some("nostr.keyfile"),
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
/// The set of refs being pushed is git's own resolved update plan, obtained via
/// `push --no-verify --dry-run --porcelain` rather than reconstructed from a
/// partial argv grammar. That plan reflects `--all`/`--mirror`/`--tags`,
/// `remote.<name>.push`, `push.default`, wildcard refspecs, aliases, and `-C`
/// context exactly as git resolves them — the whole class of predictor gaps.
/// `--no-verify` on the *probe* skips the repo's own pre-push hook (the real
/// push still runs it); enforcement itself runs unconditionally, so a
/// `--no-verify` on the real push cannot bypass it.
///
/// Scope guard against false positives: `rev-list <from> --not --remotes`
/// yields only commits absent from every remote-tracking ref. Pre-existing
/// human commits pulled in by a plain merge are excluded (they are reachable
/// from `refs/remotes/*`). A commit that a cherry-pick or rebase *replayed*
/// gets a new SHA, so it is NOT reachable from a remote and would be flagged —
/// but its patch is identical to an upstream commit, so it is exempted by
/// patch-equivalence ([`patch_equivalent_upstream`]): only genuinely new
/// agent work is required to carry the agent identity. This is what lets a
/// branch carrying rebased/cherry-picked upstream human commits push cleanly.
fn verify_push(
    real_git: &Path,
    argv: &[String],
    ctx: &[String],
    authority: &Authority,
) -> Result<(), String> {
    let expected = &authority.email;

    // git's resolved update plan. Unreachable remote / any dry-run failure =
    // fail closed with the loud message: the real push would fail anyway, and
    // an unverifiable plan must never be treated as "nothing to check".
    let sources = match resolve_push_sources(real_git, argv) {
        Some(s) => s,
        None => {
            return Err(String::from(
                "buzz git wrapper: refusing to push — could not verify outgoing commits: \
                 `git push --dry-run` failed (e.g. remote unreachable). Enforcement fails \
                 closed rather than let an unverified commit leave the machine.",
            ))
        }
    };

    let mut offenders = Vec::new();
    for from in sources {
        let shas = match rev_list_outgoing(real_git, ctx, &from) {
            Some(s) => s,
            // The plan named this ref as an update, so it resolves — an inability
            // to compute its outgoing range is a verification failure, not an
            // empty set. Fail closed.
            None => {
                return Err(format!(
                    "buzz git wrapper: refusing to push — could not verify the authorship of \
                     outgoing commits for `{from}`. Enforcement fails closed rather than let \
                     an unverified commit leave the machine."
                ))
            }
        };
        // Patch-ids of commits on a remote but not on this tip — the pool a
        // replayed (cherry-picked/rebased) upstream commit matches. Computed
        // lazily and only when a non-agent author is actually found, so the
        // ordinary all-agent push pays nothing.
        let mut upstream: Option<std::collections::HashSet<String>> = None;
        for sha in shas {
            match commit_author_email(real_git, ctx, &sha) {
                Some(email) if &email == expected => {}
                Some(email) => {
                    // A non-agent author is allowed only when this commit is a
                    // replay (same patch-id) of a commit already upstream —
                    // i.e. a cherry-picked/rebased human commit, which is
                    // correct attribution, not new agent work masquerading as
                    // someone else. Any other non-agent author is an offender.
                    let pool =
                        upstream.get_or_insert_with(|| upstream_patch_ids(real_git, ctx, &from));
                    match commit_patch_id(real_git, ctx, &sha) {
                        Some(pid) if pool.contains(&pid) => {} // replayed upstream — exempt
                        Some(_) => offenders.push((sha, email)),
                        // No patch-id (e.g. a merge, or diff-tree failed) means
                        // we cannot prove it is a replay: fail closed on it.
                        None => offenders.push((sha, email)),
                    }
                }
                // Author lookup failed for a commit that rev-list just listed:
                // fail closed rather than silently skip.
                None => {
                    return Err(format!(
                        "buzz git wrapper: refusing to push — could not read the author of \
                         outgoing commit `{}`. Enforcement fails closed.",
                        &sha[..sha.len().min(12)]
                    ))
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
    msg.push_str(expected);
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

/// The local source refs a push will send, per git's own resolved plan.
///
/// Runs the user's exact invocation with `--dry-run --porcelain --no-verify`
/// injected right after the subcommand token, so config aliases expand and
/// repository context (`-C`, `--git-dir`) applies exactly as in the real push.
/// Returns `None` on any dry-run failure (caller fails closed). Deletions and
/// up-to-date refs contribute no source; every other line's local ref (left of
/// `:` in the `from:to` field) is a source whose outgoing commits are checked.
fn resolve_push_sources(real_git: &Path, argv: &[String]) -> Option<Vec<String>> {
    let sub_idx = split_globals(argv).1?;
    let mut full = argv.to_vec();
    // Inject after the subcommand token (`push` or an alias resolving to it).
    full.splice(
        sub_idx + 1..sub_idx + 1,
        ["--dry-run", "--porcelain", "--no-verify"].map(String::from),
    );
    let arg_refs: Vec<&str> = full.iter().map(String::as_str).collect();
    // Bounded: the probe contacts the remote, so an unresponsive remote must not
    // hang the wrapper. Timeout returns `None`, which the caller fails closed on.
    let out = capture_raw_bounded(real_git, &arg_refs, DRY_RUN_TIMEOUT)?;
    if !out.status.success() {
        return None;
    }
    Some(parse_porcelain_sources(&String::from_utf8_lossy(
        &out.stdout,
    )))
}

/// Parse `--porcelain` push output into the set of local source refs whose
/// outgoing commits must be verified. Each machine line is
/// `<flag>\t<from>:<to>\t<summary>`; header (`To …`) and trailer (`Done`) lines
/// lack the tab-delimited `from:to` field and are ignored. A `-` flag (deletion)
/// or empty `from` (deletion refspec) contributes nothing.
fn parse_porcelain_sources(stdout: &str) -> Vec<String> {
    let mut sources = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.split('\t');
        let flag = fields.next().unwrap_or("");
        let refspec = match fields.next() {
            Some(r) if r.contains(':') => r,
            _ => continue, // not a plan line
        };
        if flag == "-" {
            continue; // deletion
        }
        let from = refspec.split(':').next().unwrap_or("");
        if !from.is_empty() {
            sources.push(from.to_string());
        }
    }
    sources
}

/// Preflight the resulting author of a commit-creating invocation and reject it
/// when that author would not be the agent (E). Re-applied identity config
/// cannot fix modes that reuse or preserve another commit's author —
/// `commit -C/-c <sha>` and `commit --amend` stamp the reused/original author
/// onto brand-new content. `--author`/`--reset-author` are already rejected in
/// [`enforce`]; this catches the reuse/amend forms that carry a human author
/// without naming one on the command line.
///
/// History-preserving replays (`rebase`, `cherry-pick`, `am`) are intentionally
/// untouched: preserving an upstream human author there is correct attribution,
/// and the push gate lets those through because the commits already exist
/// upstream (reachable from `refs/remotes/*`).
fn verify_commit_author(
    real_git: &Path,
    argv: &[String],
    ctx: &[String],
    authority: &Authority,
) -> Result<(), String> {
    let Some(sub_idx) = split_globals(argv).1 else {
        return Ok(());
    };
    if argv[sub_idx] != "commit" {
        return Ok(());
    }
    let args = &argv[sub_idx + 1..];

    // The reused/original author source, if any. `-C`/`-c <sha>` reuse that
    // commit's author; `--amend` (without a reuse flag) keeps HEAD's author.
    let reuse_sha = reuse_commit_arg(args);
    let source = if let Some(sha) = reuse_sha {
        Some(sha)
    } else if args.iter().any(|a| a == "--amend") {
        Some("HEAD".to_string())
    } else {
        None
    };
    let Some(source) = source else {
        return Ok(()); // ordinary commit — authored fresh as the agent
    };

    match commit_author_email(real_git, ctx, &source) {
        // Reused author is the agent (e.g. amending the agent's own commit, the
        // normal fixup flow) — allowed.
        Some(email) if email == authority.email => Ok(()),
        Some(email) => Err(format!(
            "buzz git wrapper: refusing this commit — it would be authored by `{email}`, not \
             your agent identity (`{}`). `commit --amend`/`-c`/`-C` preserve the original \
             commit's author on new content. Make a fresh commit (it is authored as your agent \
             identity automatically) and credit the human with `Co-authored-by`/`Signed-off-by` \
             trailers.",
            authority.email
        )),
        // Can't resolve the reuse source's author: fail closed.
        None => Err(format!(
            "buzz git wrapper: refusing this commit — could not determine the author that \
             `{source}` would stamp on it. Enforcement fails closed."
        )),
    }
}

/// The commit named by a `-C <sha>`/`-c <sha>` (or attached `-C<sha>`/`-c<sha>`)
/// author-and-message-reuse option on a `commit` invocation, if present. Unlike
/// the global `-c key=val` config flag, here `-c`/`-C` are `commit` options
/// whose value is a commit-ish; a value containing `=` is a config key, not a
/// commit, so it is ignored.
fn reuse_commit_arg(args: &[String]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "-C" || a == "-c" {
            return args.get(i + 1).cloned();
        }
        if let Some(v) = a
            .strip_prefix("-C")
            .or_else(|| a.strip_prefix("-c"))
            .filter(|v| !v.is_empty() && !v.contains('='))
        {
            return Some(v.to_string());
        }
        i += 1;
    }
    None
}

fn commit_author_email(real_git: &Path, ctx: &[String], sha: &str) -> Option<String> {
    capture(real_git, ctx, &["show", "-s", "--format=%ae", sha])
}

/// The stable patch-id of a single commit, or `None` if it has no diff patch-id
/// (e.g. a merge commit, or `diff-tree` produced nothing). Used to recognize a
/// cherry-picked/rebased copy of an upstream commit by patch content rather than
/// SHA, which the replay rewrote.
fn commit_patch_id(real_git: &Path, ctx: &[String], sha: &str) -> Option<String> {
    let diff = {
        let mut args = ctx.to_vec();
        args.extend(["diff-tree", "--root", "-p", sha].map(String::from));
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = capture_raw(real_git, &arg_refs)?;
        if !out.status.success() {
            return None;
        }
        out.stdout
    };
    let ids = patch_ids_from_diff(real_git, ctx, &diff);
    ids.into_iter().next()
}

/// Patch-ids of every commit reachable from a remote-tracking ref but not from
/// `from` — the pool a replayed upstream commit's patch-id must match. Bounded
/// to the divergence (`--remotes --not <from>`), and computed in one
/// `diff-tree | patch-id` pipeline. Empty on any failure, so a commit can only
/// be *exempted* when a match is positively proven (fail-closed for the gate).
fn upstream_patch_ids(
    real_git: &Path,
    ctx: &[String],
    from: &str,
) -> std::collections::HashSet<String> {
    let mut revs_args = ctx.to_vec();
    revs_args.extend(["rev-list", "--remotes", "--not", from].map(String::from));
    let revs_refs: Vec<&str> = revs_args.iter().map(String::as_str).collect();
    let revs = match capture_raw(real_git, &revs_refs) {
        Some(o) if o.status.success() => o.stdout,
        _ => return std::collections::HashSet::new(),
    };
    // Feed the SHA list to `diff-tree --stdin -p`, whose diff stream goes to
    // `patch-id`. Do it in two hops (diff-tree captured, then piped to
    // patch-id) to reuse the stdin helper without a shell.
    let diff = {
        let mut args = ctx.to_vec();
        args.extend(["diff-tree", "--stdin", "--root", "-p"].map(String::from));
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        match capture_raw_with_stdin(real_git, &arg_refs, &revs) {
            Some(o) if o.status.success() => o.stdout,
            _ => return std::collections::HashSet::new(),
        }
    };
    patch_ids_from_diff(real_git, ctx, &diff)
        .into_iter()
        .collect()
}

/// Run `git patch-id --stable` over a diff stream and return each patch-id (the
/// first whitespace field of every output line).
fn patch_ids_from_diff(real_git: &Path, ctx: &[String], diff: &[u8]) -> Vec<String> {
    let mut args = ctx.to_vec();
    args.extend(["patch-id", "--stable"].map(String::from));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = match capture_raw_with_stdin(real_git, &arg_refs, diff) {
        Some(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| l.split_whitespace().next().map(str::to_string))
        .collect()
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

/// Run `git <args...>` feeding `stdin` to its standard input and capture the
/// output. Used for the `diff-tree --stdin` / `patch-id` pipeline without a
/// shell. These operate on local objects only (no network), so no timeout.
fn capture_raw_with_stdin(
    real_git: &Path,
    args: &[&str],
    stdin: &[u8],
) -> Option<std::process::Output> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = {
        let mut cmd = std::process::Command::new(real_git);
        cmd.args(args);
        scrub_env(&mut cmd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.spawn().ok()?
    };
    child.stdin.take()?.write_all(stdin).ok()?;
    child.wait_with_output().ok()
}

/// Hard ceiling on the push `--dry-run` probe. The probe contacts the remote to
/// resolve `old..new`, so an unresponsive remote could otherwise block the
/// wrapper — and therefore the agent's `git push` — indefinitely. A synchronous
/// unbounded subprocess in an enforcement path is a defect on its own; this
/// bounds it and the caller treats a timeout as fail-closed.
const DRY_RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Like [`capture_raw`] but killed if it runs past `timeout`. Returns `None` on
/// spawn failure OR timeout (caller fails closed). The process is killed and
/// reaped on timeout so no zombie or detached network client survives.
fn capture_raw_bounded(
    real_git: &Path,
    args: &[&str],
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    use std::process::Stdio;
    use wait_timeout::ChildExt;
    let mut child = {
        let mut cmd = std::process::Command::new(real_git);
        cmd.args(args);
        scrub_env(&mut cmd);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.spawn().ok()?
    };
    match child.wait_timeout(timeout).ok()? {
        Some(_status) => child.wait_with_output().ok(),
        None => {
            // Timed out: kill and reap, then report failure (None).
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
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

/// Build the real-git argv with the authoritative identity/signing config
/// injected as command-line `-c key=value` options placed immediately before
/// the subcommand — i.e. after every global option the caller passed.
///
/// Command-line `-c` is git's highest-precedence configuration channel: it wins
/// over repo/global/system config files, over the `GIT_CONFIG_*` environment,
/// over `GIT_CONFIG_PARAMETERS`, and over `-c include.path=…`/`includeIf`
/// includes (whose settings enter at the position of their own `-c`, which the
/// caller can only place *before* ours). Placing our entries last among the
/// globals therefore makes them win regardless of what config channel the agent
/// used — the whole class of "some other channel outranks the appended env"
/// bypasses — without the wrapper having to enumerate or reject those channels.
///
/// Author/committer env vars and the command-line `--author`/`--reset-author`/
/// `--no-gpg-sign`/`-c <protected>` forms outrank even command-line `-c`; those
/// are handled separately (scrubbed and rejected in [`enforce`]).
fn inject_identity_args(argv: &[String], authority: Option<&Authority>) -> Vec<String> {
    let Some(authority) = authority else {
        return argv.to_vec();
    };
    // Splice point: the subcommand index (first non-option token), or the end
    // for a bare `git`/`git --version`-style call where the position is moot.
    let at = split_globals(argv).1.unwrap_or(argv.len());
    let mut out = argv[..at].to_vec();
    for (key, value) in &authority.entries {
        out.push("-c".to_string());
        out.push(format!("{key}={value}"));
    }
    out.extend_from_slice(&argv[at..]);
    out
}

#[cfg(unix)]
fn exec_real_git(real_git: &Path, argv: &[String], authority: Option<&Authority>) -> i32 {
    use std::os::unix::process::CommandExt;
    let full = inject_identity_args(argv, authority);
    let mut cmd = std::process::Command::new(real_git);
    cmd.args(&full);
    scrub_env(&mut cmd);
    // exec replaces this process; on success it never returns. If it returns,
    // the exec itself failed.
    let err = cmd.exec();
    eprintln!("buzz git wrapper: failed to exec real git: {err}");
    127
}

#[cfg(not(unix))]
fn exec_real_git(real_git: &Path, argv: &[String], authority: Option<&Authority>) -> i32 {
    let full = inject_identity_args(argv, authority);
    let mut cmd = std::process::Command::new(real_git);
    cmd.args(&full);
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

    const AGENT_EMAIL: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@relay.test";

    /// A managed-session authority with the standard identity/signing entries,
    /// so `enforce`/`verify_*` behave as they do in a real managed session.
    fn managed() -> Authority {
        Authority {
            entries: vec![
                ("user.name".into(), "Agent".into()),
                ("user.email".into(), AGENT_EMAIL.into()),
                ("commit.gpgSign".into(), "true".into()),
            ],
            email: AGENT_EMAIL.into(),
        }
    }

    /// Like [`managed`] but with signing disabled, for tests that create real
    /// commits through the injected argv (no GPG key available in CI).
    fn managed_nosign() -> Authority {
        Authority {
            entries: vec![
                ("user.name".into(), "Agent".into()),
                ("user.email".into(), AGENT_EMAIL.into()),
                ("commit.gpgSign".into(), "false".into()),
            ],
            email: AGENT_EMAIL.into(),
        }
    }

    // ── enforce: only enforces in a managed session ───────────────────────────

    #[test]
    fn enforce_is_a_noop_without_an_authority() {
        // An unmanaged session (no manifest) must not reject anything.
        for argv in [
            v(&["-c", "user.email=evil@x", "commit"]),
            v(&["commit", "--author=Evil <e@x>"]),
            v(&["commit", "--no-gpg-sign"]),
        ] {
            assert!(
                enforce(&argv, None).is_ok(),
                "unmanaged must allow {argv:?}"
            );
        }
    }

    // ── enforce: -c identity/signing rejection ────────────────────────────────

    #[test]
    fn rejects_dash_c_protected_keys_in_global_position() {
        let a = managed();
        for argv in [
            v(&["-c", "user.name=Evil", "commit"]),
            v(&["-c", "user.email=evil@x.com", "commit"]),
            v(&["-cuser.name=Evil", "commit"]), // attached form
            v(&["-cuser.email=e@x", "commit"]), // attached form
            v(&["-c", "USER.EMAIL=e@x", "commit"]), // case-insensitive key
            v(&["-c", "commit.gpgSign=false", "commit"]), // signing disable (F)
            v(&["-c", "user.signingkey=abc", "commit"]),
            v(&["-c", "nostr.keyfile=/tmp/evil", "commit"]),
            v(&["-c", "gpg.x509.program=/bin/false", "commit"]),
        ] {
            assert!(enforce(&argv, Some(&a)).is_err(), "must reject {argv:?}");
        }
    }

    #[test]
    fn allows_dash_c_for_unrelated_config_keys() {
        let a = managed();
        for argv in [
            v(&["-c", "core.pager=less", "log"]),
            v(&["-c", "http.proxy=x", "fetch"]),
        ] {
            assert!(enforce(&argv, Some(&a)).is_ok(), "must allow {argv:?}");
        }
    }

    #[test]
    fn commit_dash_c_reuse_message_is_not_a_config_override() {
        // `git commit -c <commit>` reuses a message; `-c` here is a commit
        // option, not the global config flag. It must not be misread as one.
        let a = managed();
        assert!(enforce(&v(&["commit", "-c", "HEAD~1"]), Some(&a)).is_ok());
        assert!(enforce(&v(&["commit", "-cuser.name=x"]), Some(&a)).is_ok());
    }

    // ── enforce: --config-env rejection ───────────────────────────────────────

    #[test]
    fn rejects_config_env_for_protected_keys() {
        let a = managed();
        assert!(enforce(&v(&["--config-env=user.name=VAR", "commit"]), Some(&a)).is_err());
        assert!(enforce(&v(&["--config-env=user.email=VAR", "commit"]), Some(&a)).is_err());
        assert!(enforce(&v(&["--config-env=commit.gpgSign=VAR", "commit"]), Some(&a)).is_err());
    }

    #[test]
    fn allows_config_env_for_unrelated_keys() {
        let a = managed();
        assert!(enforce(&v(&["--config-env=http.proxy=PROXY", "fetch"]), Some(&a)).is_ok());
    }

    // ── enforce: --author / --reset-author / --no-gpg-sign scoping ────────────

    #[test]
    fn rejects_author_overrides_on_commit_and_am() {
        let a = managed();
        for argv in [
            v(&["commit", "--author=Evil <e@x>"]),
            v(&["commit", "--author", "Evil <e@x>"]),
            v(&["commit", "--reset-author"]),
            v(&["am", "--author=Evil <e@x>"]),
        ] {
            assert!(enforce(&argv, Some(&a)).is_err(), "must reject {argv:?}");
        }
    }

    #[test]
    fn rejects_no_gpg_sign_on_signing_subcommands() {
        let a = managed();
        for argv in [
            v(&["commit", "--no-gpg-sign"]),
            v(&["tag", "-a", "v1", "--no-gpg-sign"]),
            v(&["rebase", "--no-gpg-sign", "main"]),
        ] {
            assert!(enforce(&argv, Some(&a)).is_err(), "must reject {argv:?}");
        }
    }

    #[test]
    fn allows_author_filter_on_read_side_subcommands() {
        // log/shortlog/blame --author are legitimate read filters.
        let a = managed();
        for argv in [
            v(&["log", "--author=Duncan"]),
            v(&["shortlog", "--author", "Duncan"]),
            v(&["log", "--no-gpg-sign"]), // not a signing subcommand → allowed
        ] {
            assert!(enforce(&argv, Some(&a)).is_ok(), "must allow {argv:?}");
        }
    }

    #[test]
    fn author_override_after_global_options_is_still_rejected() {
        let a = managed();
        assert!(enforce(
            &v(&["-C", "/repo", "commit", "--author=Evil <e@x>"]),
            Some(&a)
        )
        .is_err());
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

    // ── parse_porcelain_sources ───────────────────────────────────────────────

    #[test]
    fn porcelain_parse_extracts_update_sources_and_skips_deletes_and_headers() {
        let stdout = "To ../remote.git\n\
             \trefs/heads/main:refs/heads/main\t4ab76d3..c0bab62\n\
            *\trefs/heads/newbr:refs/heads/newbr\t[new branch]\n\
            =\trefs/heads/up:refs/heads/up\t[up to date]\n\
            -\t:refs/heads/tokill\t[deleted]\n\
            Done\n";
        assert_eq!(
            parse_porcelain_sources(stdout),
            vec!["refs/heads/main", "refs/heads/newbr", "refs/heads/up"]
        );
    }

    #[test]
    fn porcelain_parse_ignores_lines_without_a_refspec_field() {
        // Header/trailer and any stray non-tab lines contribute nothing.
        assert!(parse_porcelain_sources("To origin\nDone\n").is_empty());
        assert!(parse_porcelain_sources("").is_empty());
    }

    // ── reuse_commit_arg (E) ──────────────────────────────────────────────────

    #[test]
    fn reuse_commit_arg_detects_c_and_capital_c_forms() {
        assert_eq!(
            reuse_commit_arg(&v(&["-C", "HEAD~1"])).as_deref(),
            Some("HEAD~1")
        );
        assert_eq!(
            reuse_commit_arg(&v(&["-c", "abc123"])).as_deref(),
            Some("abc123")
        );
        assert_eq!(reuse_commit_arg(&v(&["-CHEAD"])).as_deref(), Some("HEAD"));
        // A `-c key=val` config value is not a commit reuse.
        assert_eq!(reuse_commit_arg(&v(&["-cuser.name=x"])), None);
        assert_eq!(reuse_commit_arg(&v(&["-m", "msg"])), None);
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

    // ── manifest round-trip ───────────────────────────────────────────────────

    #[test]
    fn authority_loads_identity_and_email_from_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let entries = vec![
            ("user.name".to_string(), "Agent".to_string()),
            ("user.email".to_string(), AGENT_EMAIL.to_string()),
            ("commit.gpgSign".to_string(), "true".to_string()),
        ];
        crate::write_identity_manifest(dir.path(), &entries).unwrap();
        let parsed = crate::read_identity_manifest(dir.path()).unwrap();
        assert_eq!(parsed, entries);
        let email = parsed
            .iter()
            .find(|(k, _)| k == "user.email")
            .map(|(_, v)| v.clone());
        assert_eq!(email.as_deref(), Some(AGENT_EMAIL));
    }

    #[test]
    fn read_identity_manifest_is_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(crate::read_identity_manifest(dir.path()).is_none());
    }

    // ── is_push_command / verify_push / verify_commit_author against real git ──

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
        assert!(matches!(
            is_push_command(
                &real_git(),
                &v(&["-C", repo.to_str().unwrap(), "pub"]),
                &ctx
            ),
            PushKind::Push
        ));
        // A non-push subcommand is not misclassified.
        assert!(matches!(
            is_push_command(
                &real_git(),
                &v(&["-C", repo.to_str().unwrap(), "status"]),
                &ctx
            ),
            PushKind::NotPush
        ));
    }

    #[test]
    fn inline_alias_resolving_to_push_is_recognized() {
        let ctx: Vec<String> = vec![];
        assert!(matches!(
            is_push_command(&real_git(), &v(&["-c", "alias.pub=push", "pub"]), &ctx),
            PushKind::Push
        ));
    }

    #[test]
    fn verify_push_rejects_human_commit_via_git_resolved_plan() {
        // No remote configured: the dry-run to a bogus remote fails, so the
        // push fails closed. Point a real remote at a fresh bare repo so the
        // plan resolves and HEAD (human-authored) shows as an offender.
        let (_d, repo) = human_authored_repo();
        let remote = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .status()
                .unwrap();
        };
        run(&["init", "-q", "--bare", remote.path().to_str().unwrap()]);
        run(&[
            "-C",
            repo.to_str().unwrap(),
            "remote",
            "add",
            "origin",
            remote.path().to_str().unwrap(),
        ]);
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        let err = verify_push(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "push", "origin", "main"]),
            &ctx,
            &managed(),
        )
        .expect_err("human-authored HEAD must be refused");
        assert!(err.contains("not authored by your agent identity"), "{err}");
    }

    #[test]
    fn verify_push_fails_closed_when_remote_unreachable() {
        let (_d, repo) = human_authored_repo();
        // origin points at a nonexistent path → dry-run fails → fail closed.
        std::process::Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "remote",
                "add",
                "origin",
                "/no/such/remote.git",
            ])
            .status()
            .unwrap();
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        let err = verify_push(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "push", "origin", "main"]),
            &ctx,
            &managed(),
        )
        .expect_err("unreachable remote must fail closed");
        assert!(err.contains("could not verify outgoing commits"), "{err}");
    }

    #[test]
    fn verify_commit_author_rejects_reuse_of_human_author() {
        // `commit -C <human HEAD>` would stamp the human author on new content.
        let (_d, repo) = human_authored_repo();
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        let err = verify_commit_author(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "commit", "-C", "HEAD"]),
            &ctx,
            &managed(),
        )
        .expect_err("reusing a human author must be refused");
        assert!(err.contains("not"), "{err}");
    }

    #[test]
    fn verify_commit_author_allows_ordinary_and_agent_amend() {
        let (_d, repo) = human_authored_repo();
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        // Ordinary commit (no reuse/amend) is authored fresh as the agent.
        assert!(verify_commit_author(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "commit", "-m", "x"]),
            &ctx,
            &managed(),
        )
        .is_ok());
        // Amending a commit already authored by the agent is the normal fixup
        // flow and must be allowed.
        let agent = managed();
        let agent_repo = tempfile::tempdir().unwrap();
        let ar = agent_repo.path();
        let g = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(ar)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .status()
                .unwrap();
        };
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.name", "Agent"]);
        g(&["config", "user.email", AGENT_EMAIL]);
        g(&["config", "commit.gpgSign", "false"]);
        std::fs::write(ar.join("f"), "x").unwrap();
        g(&["add", "f"]);
        g(&["commit", "-qm", "agent commit"]);
        let ctx2 = vec!["-C".to_string(), ar.to_string_lossy().into_owned()];
        assert!(verify_commit_author(
            &real_git(),
            &v(&["-C", ar.to_str().unwrap(), "commit", "--amend", "--no-edit"]),
            &ctx2,
            &agent,
        )
        .is_ok());
    }

    // ── helpers for exec-level identity/push tests ─────────────────────────────

    /// Run `git` in `repo` with the given argv and hermetic global/system config.
    fn git_in(repo: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap()
    }

    /// Author email of `rev` in `repo`, trimmed.
    fn author_email(repo: &Path, rev: &str) -> String {
        let out = git_in(repo, &["show", "-s", "--format=%ae", rev]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    // ── C1: injected `-c` identity outranks every other config channel ─────────

    /// The wrapper's re-applied command-line `-c user.email=…` must dominate the
    /// author even when the agent tries to smuggle a human identity in through a
    /// lower-precedence channel: `GIT_CONFIG_PARAMETERS`, a `-c include.path`
    /// include, and repo-file config. Exercised through `inject_identity_args`
    /// (what `exec_real_git` splices) plus a real `git commit`.
    #[test]
    fn injected_identity_outranks_config_parameters_and_include_path() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git_in(repo, &["init", "-q", "-b", "main"]);
        // Repo-file config claims a human identity (a legitimate lower channel).
        git_in(repo, &["config", "user.name", "Human"]);
        git_in(repo, &["config", "user.email", "human@example.com"]);
        git_in(repo, &["config", "commit.gpgSign", "false"]);

        // An include file that also tries to set a human identity.
        let inc = repo.join("evil.inc");
        std::fs::write(&inc, "[user]\n\temail = include@evil.com\n").unwrap();

        std::fs::write(repo.join("f"), "x").unwrap();
        git_in(repo, &["add", "f"]);

        // Caller argv smuggles identity via a `-c include.path` global. The
        // wrapper splices its authoritative `-c user.email=<agent>` AFTER this,
        // so command-line precedence (last `-c` wins) must make the agent win.
        let caller = v(&[
            "-c",
            &format!("include.path={}", inc.display()),
            "commit",
            "-qm",
            "smuggled",
        ]);
        let full = inject_identity_args(&caller, Some(&managed_nosign()));
        let refs: Vec<&str> = full.iter().map(String::as_str).collect();

        // Also arm the env channel the wrapper re-append is meant to defeat.
        let params = "'user.email=params@evil.com'";
        let out = std::process::Command::new("git")
            .args(&refs)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_PARAMETERS", params)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "commit failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            author_email(repo, "HEAD"),
            AGENT_EMAIL,
            "injected -c identity must beat include.path, GIT_CONFIG_PARAMETERS, and repo config"
        );
    }

    // ── C2: a shell (`!`) alias that may push is rejected, never probed ────────

    /// `is_push_command` must classify a `!`-shell alias whose body invokes
    /// `push` as `OpaqueShellAlias` (rejected by the caller) rather than resolve
    /// it — resolving would require executing the shell body, which could push
    /// before verification.
    #[test]
    fn shell_alias_that_may_push_is_opaque_not_probed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git_in(repo, &["init", "-q", "-b", "main"]);
        // A `!`-alias whose body would push. A sentinel file proves the body
        // never runs during classification.
        let sentinel = repo.join("ran");
        let body = format!("!touch {} && git push", sentinel.display());
        git_in(repo, &["config", "alias.deploy", &body]);

        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        let kind = is_push_command(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "deploy"]),
            &ctx,
        );
        match kind {
            PushKind::OpaqueShellAlias(name) => assert_eq!(name, "deploy"),
            _ => panic!("expected OpaqueShellAlias"),
        }
        assert!(
            !sentinel.exists(),
            "classification must not execute the shell alias body"
        );
    }

    /// A `!`-shell alias whose body does NOT push is not misclassified as a push
    /// (it needs no push verification).
    #[test]
    fn shell_alias_without_push_is_not_a_push() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git_in(repo, &["init", "-q", "-b", "main"]);
        git_in(repo, &["config", "alias.st", "!git status"]);
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        assert!(matches!(
            is_push_command(&real_git(), &v(&["-C", repo.to_str().unwrap(), "st"]), &ctx),
            PushKind::NotPush
        ));
    }

    // ── I3: cherry-picked / rebased upstream human commits are exempt ──────────

    /// Build `(dir, local, remote)` where `remote` (a real bare repo wired as
    /// `origin` and fetched) carries a human-authored commit, and `local` is on
    /// a branch forked from the shared base. Returns paths for building the two
    /// rebase/cherry-pick shapes on top.
    fn repo_with_upstream_human_commit() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        let local = dir.path().join("local");
        // Seed remote via a scratch working clone, then discard it.
        git_in(
            dir.path(),
            &["init", "-q", "--bare", remote.to_str().unwrap()],
        );
        let seed = dir.path().join("seed");
        git_in(
            dir.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                seed.to_str().unwrap(),
            ],
        );
        git_in(&seed, &["config", "user.name", "Human"]);
        git_in(&seed, &["config", "user.email", "human@example.com"]);
        git_in(&seed, &["config", "commit.gpgSign", "false"]);
        std::fs::write(seed.join("base"), "b").unwrap();
        git_in(&seed, &["add", "base"]);
        git_in(&seed, &["commit", "-qm", "base"]);
        std::fs::write(seed.join("human"), "h").unwrap();
        git_in(&seed, &["add", "human"]);
        git_in(&seed, &["commit", "-qm", "human work"]);
        git_in(&seed, &["push", "-q", "origin", "HEAD:main"]);

        // Local clone forked from the shared BASE (not the human tip).
        git_in(
            dir.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        );
        git_in(&local, &["config", "user.name", "Agent"]);
        git_in(&local, &["config", "user.email", AGENT_EMAIL]);
        git_in(&local, &["config", "commit.gpgSign", "false"]);
        (dir, local, remote)
    }

    /// I3 shape B (the shape that exercises the fix): the agent rebases/rewrites
    /// the UPSTREAM human commit onto a new base, giving it a fresh SHA. That
    /// new SHA is not reachable from `refs/remotes/*`, so the naive
    /// `rev-list --not --remotes` flags it — but its patch-id matches the
    /// upstream original, so the exemption must let the push through.
    #[test]
    fn verify_push_exempts_rebased_upstream_human_commit_by_patch_id() {
        let (_d, local, _remote) = repo_with_upstream_human_commit();
        // Reset local to the shared base, then cherry-pick the upstream human
        // commit — a replay that rewrites its SHA but preserves its patch and
        // its human author. This is the correct-attribution case the gate must
        // NOT refuse.
        git_in(&local, &["reset", "-q", "--hard", "origin/main~1"]);
        let human_sha =
            String::from_utf8_lossy(&git_in(&local, &["rev-parse", "origin/main"]).stdout)
                .trim()
                .to_string();
        // Add an agent commit first, then replay the human commit on top so the
        // outgoing range is {agent, replayed-human} — both must be allowed.
        std::fs::write(local.join("agent"), "a").unwrap();
        git_in(&local, &["add", "agent"]);
        git_in(&local, &["commit", "-qm", "agent work"]);
        let cp = git_in(&local, &["cherry-pick", &human_sha]);
        assert!(
            cp.status.success(),
            "cherry-pick failed: {}",
            String::from_utf8_lossy(&cp.stderr)
        );

        let ctx = vec!["-C".to_string(), local.to_string_lossy().into_owned()];
        let res = verify_push(
            &real_git(),
            &v(&[
                "-C",
                local.to_str().unwrap(),
                "push",
                "origin",
                "HEAD:refs/heads/feature",
            ]),
            &ctx,
            &managed_nosign(),
        );
        assert!(
            res.is_ok(),
            "replayed upstream human commit must be exempt by patch-id, got: {res:?}"
        );
    }

    /// I3 shape A (agent-onto-human, the ordinary rebase): the agent's own
    /// commit sits on top of the upstream human tip. Only the agent commit is
    /// outgoing; the human commit is already reachable from `refs/remotes/*`.
    /// The push must be allowed, and it exercises the no-exemption-needed path.
    #[test]
    fn verify_push_allows_agent_commit_atop_upstream_human_tip() {
        let (_d, local, _remote) = repo_with_upstream_human_commit();
        std::fs::write(local.join("agent"), "a").unwrap();
        git_in(&local, &["add", "agent"]);
        git_in(&local, &["commit", "-qm", "agent work"]);
        let ctx = vec!["-C".to_string(), local.to_string_lossy().into_owned()];
        let res = verify_push(
            &real_git(),
            &v(&[
                "-C",
                local.to_str().unwrap(),
                "push",
                "origin",
                "HEAD:refs/heads/feature",
            ]),
            &ctx,
            &managed_nosign(),
        );
        assert!(
            res.is_ok(),
            "agent commit atop upstream human tip must be allowed: {res:?}"
        );
    }

    /// A genuinely NEW human-authored commit (no upstream patch-id match) is
    /// still refused — the patch-id exemption must not become a blanket pass.
    #[test]
    fn verify_push_still_rejects_new_human_commit_without_upstream_match() {
        let (_d, local, _remote) = repo_with_upstream_human_commit();
        // A fresh human-authored commit that exists nowhere upstream.
        std::fs::write(local.join("new"), "n").unwrap();
        git_in(&local, &["add", "new"]);
        git_in(
            &local,
            &[
                "-c",
                "user.name=Human",
                "-c",
                "user.email=human@example.com",
                "commit",
                "-qm",
                "brand-new human work",
            ],
        );
        let ctx = vec!["-C".to_string(), local.to_string_lossy().into_owned()];
        let err = verify_push(
            &real_git(),
            &v(&[
                "-C",
                local.to_str().unwrap(),
                "push",
                "origin",
                "HEAD:refs/heads/feature",
            ]),
            &ctx,
            &managed_nosign(),
        )
        .expect_err("a brand-new human commit must be refused");
        assert!(err.contains("not authored by your agent identity"), "{err}");
    }

    // ── I6: the dry-run probe is bounded and a timeout fails closed ────────────

    /// `capture_raw_bounded` must kill and report failure (`None`) when the
    /// child outlives the timeout, so a hung remote probe cannot block the
    /// wrapper indefinitely. Uses a tiny timeout against a sleep to prove the
    /// bound fires without depending on real network latency.
    #[test]
    fn capture_raw_bounded_times_out_and_fails_closed() {
        // `sleep` via any binary on PATH would do; use the shell so the timeout
        // is deterministic regardless of installed git. We invoke `sh -c sleep`
        // as the "real git" stand-in — capture_raw_bounded only cares that the
        // child runs longer than the timeout.
        let start = std::time::Instant::now();
        let out = capture_raw_bounded(
            Path::new("sh"),
            &["-c", "sleep 5"],
            std::time::Duration::from_millis(200),
        );
        assert!(
            out.is_none(),
            "a child exceeding the timeout must yield None"
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(3),
            "the bound must fire well before the child would finish"
        );
    }

    /// A child that completes within the timeout returns its output normally.
    #[test]
    fn capture_raw_bounded_returns_output_within_timeout() {
        let out = capture_raw_bounded(
            Path::new("sh"),
            &["-c", "printf ok"],
            std::time::Duration::from_secs(5),
        )
        .expect("fast child must produce output");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok");
    }
}

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
//!    is authored by the agent identity and carries a valid NIP-GS signature by
//!    the agent key. This closes unsigned agent commits from
//!    `merge`/`pull`/`commit-tree`/plumbing that the flag-based `enforce`
//!    cannot reject. Fails the push otherwise.
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

/// Maximum number of ordinary alias substitutions the managed wrapper resolves.
/// The next command token is always inspected too, so a chain with exactly this
/// many aliases may terminate at a real subcommand; a further alias is refused.
const MAX_ALIAS_HOPS: usize = 10;

/// Long global options that consume the *following* argv token as their value
/// (the `--opt value` form; the `--opt=value` form is self-contained). This
/// table is load-bearing for the whole enforcement design: [`split_globals`] is
/// the single point of truth for where the subcommand begins, and every alias
/// and push-verification probe resolves under the globals it extracts. Any
/// separate-value global git honors but this table omits desyncs the probe from
/// the real invocation and reopens an enforcement bypass (round-7 `--shallow-file`).
///
/// Must match git's `handle_options()` exactly. Audited against
/// [git.c v2.54.0](https://github.com/git/git/blob/v2.54.0/git.c#L233-L370):
/// the complete set of separate-value globals is `--git-dir`, `--work-tree`,
/// `--namespace`, `--config-env`, `--attr-source`, and `--shallow-file`.
/// `--super-prefix` is retained though v2.54 rejects it globally (over-enumeration
/// is inert: it only ever pairs a value git would itself refuse). Re-audit this
/// table when bumping the pinned git version.
const VALUE_LONG_OPTS: &[&str] = &[
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--attr-source",
    "--shallow-file",
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
    /// The install dir is located and holds a complete, self-consistent
    /// manifest: enforce (author identity AND a signature by the agent key).
    Managed(Authority),
    /// The install dir is located but its manifest is missing, unreadable, or
    /// does not carry the complete managed signing contract (see
    /// [`Authority::classify`]). A managed install always writes the full
    /// contract via [`crate::identity_signing_entries`], and `user` mode
    /// installs no manifest at all — so an incomplete or inconsistent manifest
    /// means the authority was removed, corrupted, or tampered after install.
    /// Fail closed rather than silently drop or misdirect enforcement.
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
        Self::classify(entries)
    }

    /// Validate a parsed manifest against the complete managed signing contract,
    /// returning [`AuthorityState::Managed`] only when every part holds and
    /// [`AuthorityState::Tampered`] otherwise. Pure over its `entries` input so
    /// it is testable without `PATH`/filesystem.
    ///
    /// A managed install is written solely by [`crate::identity_signing_entries`]
    /// (agent mode); `user` mode writes no manifest. So a valid manifest carries
    /// EXACTLY the eight canonical keys that function writes, each once, with the
    /// fixed values ([`crate::FIXED_SIGNING_ENTRIES`]) and a `user.signingkey`
    /// equal to the pubkey encoded in `user.email`. Any deviation is tampering
    /// and fails closed:
    ///
    /// - Dropping/falsifying `commit.gpgSign` would leave the signature gate off.
    /// - Swapping `user.signingkey` to another key would make the push probe
    ///   accept a valid signature by the *wrong* key while the commit still
    ///   appears authored as the agent.
    /// - Because git config is last-value-wins and the accepted entries are
    ///   injected verbatim as `-c` into every commit and the signature probe, a
    ///   *duplicate* later `user.signingkey`, or any *unknown* key (e.g. an
    ///   `include.path` that pulls in another key file), could redirect the key
    ///   the probe trusts. Rejecting duplicate and unknown keys — and rebuilding
    ///   the authority's entries solely from the validated canonical fields, so
    ///   nothing unvalidated crosses into git — closes that class by
    ///   construction.
    fn classify(entries: Vec<(String, String)>) -> AuthorityState {
        // Collect each canonical key's single value, rejecting duplicates and
        // unknown keys. `CANONICAL_KEYS` mirrors `identity_signing_entries`.
        const CANONICAL_KEYS: &[&str] = &[
            "user.name",
            "user.email",
            "gpg.format",
            "gpg.x509.program",
            "commit.gpgSign",
            "tag.gpgSign",
            "user.signingkey",
            "nostr.keyfile",
        ];
        let mut seen: Vec<Option<String>> = vec![None; CANONICAL_KEYS.len()];
        for (key, value) in entries {
            let Some(idx) = CANONICAL_KEYS
                .iter()
                .position(|k| key.eq_ignore_ascii_case(k))
            else {
                return AuthorityState::Tampered; // unknown key
            };
            if seen[idx].replace(value).is_some() {
                return AuthorityState::Tampered; // duplicate key
            }
        }
        let get = |name: &str| {
            let idx = CANONICAL_KEYS.iter().position(|k| *k == name).unwrap();
            seen[idx].as_deref()
        };

        // Author identity must be present and non-empty.
        let Some(email) = get("user.email")
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
        else {
            return AuthorityState::Tampered;
        };
        if get("user.name").is_none_or(str::is_empty) {
            return AuthorityState::Tampered;
        }
        // The fixed signing entries must carry their canonical values byte for
        // byte. `gpg.x509.program` pins the verifier the push probe invokes, and
        // the installers emit exactly one canonical spelling, so any case
        // variance is tampering: on a case-sensitive host `GIT-SIGN-NOSTR`
        // resolves past the managed install to an agent-controlled binary later
        // on PATH. Comparing verbatim keeps the probe bound to the real signer.
        let fixed_ok = crate::FIXED_SIGNING_ENTRIES
            .iter()
            .all(|&(k, expected)| get(k) == Some(expected));
        if !fixed_ok || get("nostr.keyfile").is_none_or(str::is_empty) {
            return AuthorityState::Tampered;
        }
        // `user.signingkey` must be the pubkey the author email encodes
        // (`<pubkey_hex>@<host>`), so the key the probe trusts is the same key
        // the commit is attributed to.
        let email_pubkey = email.split('@').next().unwrap_or("");
        if email_pubkey.is_empty()
            || get("user.signingkey").is_none_or(|k| !k.eq_ignore_ascii_case(email_pubkey))
        {
            return AuthorityState::Tampered;
        }

        // Rebuild the entries from the validated canonical fields in the order
        // `identity_signing_entries` writes them — nothing unvalidated (a
        // duplicate, an unknown redirect key) crosses into the `-c` injection.
        let canonical: Vec<(String, String)> = CANONICAL_KEYS
            .iter()
            .map(|k| ((*k).to_owned(), get(k).unwrap_or_default().to_owned()))
            .collect();
        AuthorityState::Managed(Self {
            entries: canonical,
            email,
        })
    }
}

/// Entry point for the `git` multicall personality. Never returns on success
/// (execs real git on Unix); returns the process exit code on Windows/error.
pub fn run() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();

    // Classify the authority. `Tampered` (install dir located but manifest
    // missing/unreadable or not carrying the complete, self-consistent signing
    // contract) fails closed for every command: a managed install always writes
    // the full contract and `user` mode writes no manifest, so anything weaker
    // means the authority was removed, damaged, or tampered after install, and
    // continuing would silently drop or misdirect enforcement.
    let authority = match Authority::load() {
        AuthorityState::Managed(a) => Some(a),
        AuthorityState::Unmanaged => None,
        AuthorityState::Tampered => {
            eprintln!(
                "buzz git wrapper: refusing to run — this `git` is a managed enforcement \
                 wrapper but its identity manifest is missing, unreadable, or does not carry \
                 the complete signing contract (a valid manifest names the agent identity and \
                 a matching signing key). Enforcement fails closed rather than fall back to an \
                 ambient identity or trust the wrong signing key."
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

    let ctx = caller_globals(&argv);

    // Alias preflight + unification. `verify_alias_safety` refuses every shell
    // (`!`) alias and every non-shell alias carrying config/quoting the wrapper
    // cannot classify; on success it returns the alias's fully-resolved bare-word
    // expansion (or `None` when no alias was involved). We then hold that
    // expansion to the SAME `enforce`/`verify_commit_author` policy as a directly
    // typed command — keyed on the *expanded* subcommand — so an alias can never
    // do more than its expansion could. `enforce`/`verify_commit_author` on the
    // literal argv below cannot catch alias-carried flags (`git human` expands to
    // `commit --author …`, but the literal subcommand is `human`); the expanded
    // preflight closes that gap by construction, with no alias-specific flag list.
    if let Some(auth) = &authority {
        match verify_alias_safety(&real_git, &argv, &ctx) {
            Ok(None) => {}
            Ok(Some(expanded)) => {
                if let Err(msg) = enforce(&expanded, Some(auth)) {
                    eprintln!("{msg}");
                    return 1;
                }
                if let Err(msg) = verify_commit_author(&real_git, &expanded, &ctx, auth) {
                    eprintln!("{msg}");
                    return 1;
                }
            }
            Err(msg) => {
                eprintln!("{msg}");
                return 1;
            }
        }
    }

    // Author preflight (E): commit modes that reuse or preserve another author
    // (`-C`/`-c <sha>`, `--amend`) create NEW commits stamped with that author.
    // Re-applied identity config cannot fix this — git honours the reused
    // author — so reject when the resulting author would not be the agent. This
    // covers a directly-typed `commit`; an alias resolving to one is covered by
    // the expanded-command preflight above.
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

/// Every global option the caller placed before the subcommand — the complete
/// set git itself consumes before dispatching to the subcommand. This is the
/// probe context for *every* verification probe: alias resolution
/// ([`verify_alias_safety`], [`is_push_command`]) and the outgoing-commit
/// authorship/signature checks ([`partition_outgoing`] via [`rev_list_outgoing`],
/// [`commit_author_email`], [`commit_signature_is_agent`]). Each probe MUST run
/// under the same effective repository and configuration git will use for the
/// real invocation, or it resolves a different view and enforcement is bypassed.
///
/// INVARIANT — pass the caller's globals through wholesale; never an allowlist.
/// This boundary was reopened three times by enumerating "known" context
/// globals and missing one: repo-config keys (round 4), the config-injection
/// channels `-c`/`--config-env`/`include.path` (round 6), then `--bare` — which
/// changes repository discovery and therefore *which* config file supplies an
/// alias, so an allowlist that dropped it let `git --bare <dir> x` expand an
/// alias the probe never saw. The complete-set rule closes the whole class:
///   • Any global that would corrupt a probe corrupts the real invocation
///     identically (git parses globals before subcommand dispatch), so probe
///     and real git always share one view and fail closed together — no probe
///     can go blind (fail-open) while real git still expands an alias.
///   • Pager/cosmetic globals (`-p`, `--paginate`, `--no-optional-locks`, …)
///     are inert: probes capture piped stdout, so git auto-disables the pager,
///     and none introduce config or aliases.
///   • `--exec-path=` redirects builtin lookup for probe and real git alike;
///     `config`/`rev-list`/`show`/`diff-tree`/`patch-id` are builtins, so it
///     cannot make the probe resolve a different alias set than real git.
/// The authoritative identity/signing `-c` entries always splice *after* these
/// caller globals ([`inject_identity_args`], [`commit_signature_is_agent`]), so
/// command-line last-wins precedence keeps a caller `-c` from overriding them.
fn caller_globals(argv: &[String]) -> Vec<String> {
    split_globals(argv).0
}

/// The effective-command classification of an invocation.
enum PushKind {
    /// The effective command is not `push`.
    NotPush,
    /// The effective command resolves to `push` through ordinary (config/inline)
    /// git aliases; its transport plan can be resolved safely with `--dry-run`.
    Push,
}

/// Classify the invocation's *effective* command, resolving ordinary git
/// aliases so `git pub` (with `alias.pub = push`) and `git -c alias.pub=push
/// pub` are both recognized. Aliases are read under `ctx` — the caller's
/// complete global set ([`caller_globals`]) — so the probe consults the exact
/// same aliases git will, including those introduced by a `-c include.path`/
/// `--config-env`, case-varied `-c ALIAS.x`, or a repo view selected by
/// `--bare`/`--git-dir`.
///
/// This runs only in a managed session, *after* [`verify_alias_safety`] has
/// already refused every shell (`!`) alias and every non-shell alias that is
/// not a trivially-safe bare-word chain — so a shell alias never reaches here.
/// Recursion is bounded to defeat cyclic alias definitions.
fn is_push_command(real_git: &Path, argv: &[String], ctx: &[String]) -> PushKind {
    let mut name = match subcommand(argv) {
        Some(s) => s,
        None => return PushKind::NotPush,
    };
    for _ in 0..10 {
        if name == "push" {
            return PushKind::Push;
        }
        let def = capture(
            real_git,
            ctx,
            &["config", "--get", &format!("alias.{name}")],
        );
        let def = match def {
            Some(d) => d,
            None => return PushKind::NotPush, // not an alias — effective command
        };
        if def.starts_with('!') {
            return PushKind::NotPush; // shell alias — already refused upstream
        }
        match def.split_whitespace().next() {
            Some(first) => name = first.to_string(),
            None => return PushKind::NotPush,
        }
    }
    PushKind::NotPush
}

/// Refuse any alias the wrapper cannot *trivially* prove safe, and — on success
/// — return the alias's fully-resolved expansion so the caller can hold it to
/// the same policy as a directly-typed command. Git expands an alias in-process,
/// and its config-bearing globals land *after* the identity/signing `-c` options
/// this wrapper injects before the subcommand ([`inject_identity_args`]), so an
/// alias could otherwise plant higher-precedence config that re-authors or
/// unsigns the commit. It could equally carry identity/signing *flags*
/// (`--author`, `--no-gpg-sign`, `--amend`, commit reuse). [`enforce`] and
/// [`verify_commit_author`] cannot catch either on the literal argv: they key on
/// the typed subcommand, which for `git human` is the alias name `human`, never
/// the expanded `commit`.
///
/// This is an allowlist, not a blocklist. Rather than model git's alias grammar
/// (whose quote-aware parser would let `'-c' 'user.email=…'` slip past a
/// naive token scan), it admits an alias only when every token of its body is a
/// trivially-safe bare word: no quote or backslash characters, no `-c`/
/// `--config-env` config channel, and no `=`-valued option. Anything the
/// wrapper cannot classify at a glance is refused (favor-rejection).
///
/// The returned expansion is exactly the token list git would run — the typed
/// globals, then the recursively-expanded command with accumulated body tokens
/// and the user's trailing argv. Holding it to [`enforce`]/[`verify_commit_author`]
/// keyed on the *expanded* subcommand means an alias can never do more than its
/// expansion could typed directly, so no alias-specific flag list exists to keep
/// in sync. `Ok(None)` means the typed subcommand was a real command (no alias).
///
/// Shell (`!`) aliases are refused outright in a managed session. Git runs an
/// `!` alias with its own exec-path prepended to `PATH`, so the inner `git` is
/// the *real* binary, not this wrapper — its `-c` outranks the inherited env
/// authority and can commit as an arbitrary human, unsigned. Their bodies are
/// arbitrary shell, so there is no safe subset to allow.
///
/// Allowed shapes stay working: `alias.ci = commit`, `alias.st = status`,
/// `alias.lg = log --oneline`, `alias.pub = push origin main`. Recursion is
/// bounded to defeat cyclic alias definitions. After the bound is reached, the
/// next command token must be a real subcommand or the wrapper refuses rather
/// than treating a partial expansion as resolved.
fn verify_alias_safety(
    real_git: &Path,
    argv: &[String],
    ctx: &[String],
) -> Result<Option<Vec<String>>, String> {
    let (_, sub_idx) = split_globals(argv);
    let Some(sub_idx) = sub_idx else {
        return Ok(None); // no subcommand — nothing to expand
    };
    // The command chain being expanded: the subcommand token and its trailing
    // argv. Typed globals (argv[..sub_idx]) are prepended to the final result.
    let mut chain: Vec<String> = argv[sub_idx..].to_vec();
    let mut resolved_any = false;
    for _ in 0..MAX_ALIAS_HOPS {
        // The command word within the current chain (git re-parses leading
        // options as globals after each expansion, so a body may begin with
        // bare-word options before its subcommand).
        let Some(cmd_idx) = split_globals(&chain).1 else {
            break; // no command word left
        };
        let name = &chain[cmd_idx];
        let def = capture(
            real_git,
            ctx,
            &["config", "--get", &format!("alias.{name}")],
        );
        let Some(def) = def else {
            break; // real subcommand — chain is fully expanded
        };
        if def.starts_with('!') {
            return Err(shell_alias_reject_message(name));
        }
        let body: Vec<String> = def.split_whitespace().map(String::from).collect();
        if !body.iter().all(|t| is_safe_alias_token(t)) {
            return Err(alias_reject_message(name));
        }
        // Substitute the command word with its body, exactly as git does.
        chain.splice(cmd_idx..=cmd_idx, body);
        resolved_any = true;
    }
    let Some(cmd_idx) = split_globals(&chain).1 else {
        return Err(alias_limit_reject_message());
    };
    let name = &chain[cmd_idx];
    if capture(
        real_git,
        ctx,
        &["config", "--get", &format!("alias.{name}")],
    )
    .is_some()
    {
        return Err(alias_limit_reject_message());
    }
    if !resolved_any {
        return Ok(None);
    }
    let mut expanded = argv[..sub_idx].to_vec();
    expanded.extend(chain);
    Ok(Some(expanded))
}

/// A single alias-body token is safe only when it is a plain bare word that
/// introduces no configuration and needs no shell/quote interpretation. This is
/// deliberately conservative: git's quote-aware alias parser sees a token
/// differently from our whitespace split, so any token carrying a quote or
/// escape is refused rather than guessed at.
fn is_safe_alias_token(token: &str) -> bool {
    // Quote/escape characters: git would dequote these, changing the token from
    // what we scanned. Refuse — the allowlist never reasons about quoted forms.
    if token.contains(['\'', '"', '\\']) {
        return false;
    }
    // The config-injection channels, in any spelling.
    if token == "-c"
        || token.starts_with("-c")
        || token == "--config-env"
        || token.starts_with("--config-env")
    {
        return false;
    }
    // Any other option carrying a `=` value (e.g. `--author=…`, `--foo=bar`)
    // can redirect identity/behaviour we cannot classify — refuse.
    if token.starts_with('-') && token.contains('=') {
        return false;
    }
    true
}

fn alias_reject_message(name: &str) -> String {
    format!(
        "buzz git wrapper: refusing `{name}` — this git alias contains tokens the managed \
         wrapper cannot verify as safe (quoting/escaping, `-c`/`--config-env`, or a \
         value-bearing option). Aliases that could carry configuration are refused because \
         git applies alias config after the managed agent identity and signing config. Run \
         the underlying git command directly; agent commit identity and signing are \
         machine-managed."
    )
}

fn alias_limit_reject_message() -> String {
    format!(
        "buzz git wrapper: refusing alias chain after {MAX_ALIAS_HOPS} expansions — the managed \
         wrapper only runs a command after proving its final command word is not another git alias. \
         Run the underlying git command directly; agent commit identity and signing are \
         machine-managed."
    )
}

fn shell_alias_reject_message(name: &str) -> String {
    format!(
        "buzz git wrapper: refusing `{name}` — it is a shell (`!`) git alias. Git runs `!` \
         aliases with the real git ahead of this wrapper on PATH, so their body can commit \
         or push under an arbitrary identity, unsigned. Run the underlying git command \
         directly; agent commit identity and signing are machine-managed."
    )
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

/// Walk the outgoing commits for each source ref once, partitioning them into
/// `(offenders, agent_shas)`: non-agent-authored commits that are NOT a
/// replayed-upstream commit (attribution failures) and agent-authored commit
/// SHAs (whose signature the caller must still verify). Fails closed (`Err`) on
/// any probe error — an unverifiable commit must never be treated as clean.
///
/// Split out of [`verify_push`] so the authorship logic — including the
/// cherry-pick/rebase patch-id exemption — is unit-testable without a signer,
/// which the unconditional signature check in `verify_push` would otherwise
/// require for every agent commit.
#[allow(clippy::type_complexity)]
fn partition_outgoing(
    real_git: &Path,
    ctx: &[String],
    expected: &str,
    sources: &[String],
) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    let mut offenders = Vec::new();
    let mut agent_shas = Vec::new();
    for from in sources {
        let shas = match rev_list_outgoing(real_git, ctx, from) {
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
                // Agent-authored: attribution is correct. Signature is checked
                // by the caller.
                Some(email) if email == expected => agent_shas.push(sha),
                Some(email) => {
                    // A non-agent author is allowed only when this commit is a
                    // replay (same patch-id) of a commit already upstream —
                    // i.e. a cherry-picked/rebased human commit, which is
                    // correct attribution, not new agent work masquerading as
                    // someone else. Any other non-agent author is an offender.
                    let pool =
                        upstream.get_or_insert_with(|| upstream_patch_ids(real_git, ctx, from));
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
    Ok((offenders, agent_shas))
}

/// Verify that every commit being pushed that is not already on a remote is
/// authored by the agent identity and carries a valid NIP-GS signature by the
/// agent key. `Ok(())` allows the push. Every valid [`Authority`] enforces
/// signing (the manifest contract guarantees it), so the signature requirement
/// is unconditional here.
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

    // One walk of the outgoing commits, partitioned by the two distinct
    // enforcement concerns: authorship (non-agent authors that are not a
    // replayed-upstream commit) and signing (agent-authored commits whose
    // signature must be verified). Fails closed on any probe error.
    let (offenders, agent_shas) = partition_outgoing(real_git, ctx, expected, &sources)?;

    // Every valid `Authority` enforces signing (the manifest contract
    // guarantees `commit.gpgSign=true` and a signing key matching the author
    // email), so each agent-authored outgoing commit MUST carry a valid
    // signature by the agent key — the one check that covers every creation
    // path (`merge`/`pull`/`commit-tree`/plumbing) `enforce` cannot reject.
    let mut unsigned = Vec::new();
    for sha in agent_shas {
        match commit_signature_is_agent(real_git, ctx, authority, &sha) {
            Some(true) => {}
            Some(false) => unsigned.push(sha),
            // The verification probe itself failed to run: fail closed rather
            // than let an unverified commit leave.
            None => {
                return Err(format!(
                    "buzz git wrapper: refusing to push — could not verify the \
                     signature of outgoing commit `{}`. Enforcement fails closed.",
                    &sha[..sha.len().min(12)]
                ))
            }
        }
    }

    if offenders.is_empty() && unsigned.is_empty() {
        return Ok(());
    }
    let mut msg = String::new();
    if !offenders.is_empty() {
        msg.push_str(
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
    }
    if !unsigned.is_empty() {
        if !msg.is_empty() {
            msg.push('\n');
        }
        msg.push_str(
            "buzz git wrapper: refusing to push — these outgoing commits are authored by your \
             agent identity but carry no valid signature by your agent key (e.g. created via \
             `git merge`/`pull --no-gpg-sign` or `commit-tree`):\n",
        );
        for sha in &unsigned {
            msg.push_str(&format!("  {}\n", &sha[..sha.len().min(12)]));
        }
        msg.push_str(
            "Re-sign them under the managed identity (e.g. `git rebase --exec 'git commit \
             --amend --no-edit -S' <base>`) before pushing.",
        );
    }
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

/// Whether `sha` carries a valid NIP-GS signature by the agent key. Returns
/// `Some(true)` only when git's signature-status placeholder `%G?` is `G` —
/// a good signature whose key is `TRUST_FULLY`, which `git-sign-nostr` emits
/// solely when the verified key equals the configured `user.signingkey`. So `G`
/// means both "cryptographically valid" and "by the expected agent key" in one
/// git-native, network-free probe. `Some(false)` is any other status
/// (`N` unsigned, `U`/`E` valid-but-untrusted/uncheckable, `B` bad). `None`
/// only when the probe itself fails to run — the caller fails closed on that.
///
/// The authority's signing config (`gpg.x509.program`, `user.signingkey`,
/// `nostr.keyfile`) is injected as `-c` so the probe invokes `git-sign-nostr`
/// and resolves trust against the agent key regardless of the repo's own
/// config, mirroring how [`inject_identity_args`] arms real commits.
fn commit_signature_is_agent(
    real_git: &Path,
    ctx: &[String],
    authority: &Authority,
    sha: &str,
) -> Option<bool> {
    let mut args = ctx.to_vec();
    for (key, value) in &authority.entries {
        args.push("-c".to_string());
        args.push(format!("{key}={value}"));
    }
    args.extend(["show", "-s", "--format=%G?", sha].map(String::from));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = capture_raw(real_git, &arg_refs)?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim() == "G")
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
/// `ctx` carries the caller's complete global set ([`caller_globals`]) so the
/// probe resolves against the same repository, config, and aliases git will use
/// for the real invocation.
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
    /// The pubkey `AGENT_EMAIL` encodes — the `user.signingkey` a valid managed
    /// manifest must name.
    const AGENT_PUBKEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// A managed-session authority with the COMPLETE signing contract — the
    /// state [`Authority::classify`] accepts as `Managed`. Used by the push
    /// tests: `verify_push` requires a signature by the agent key on every
    /// agent-authored commit, and these entries are the authority that check
    /// resolves against.
    fn managed() -> Authority {
        Authority {
            entries: vec![
                ("user.name".into(), "Agent".into()),
                ("user.email".into(), AGENT_EMAIL.into()),
                ("gpg.format".into(), "x509".into()),
                ("gpg.x509.program".into(), "git-sign-nostr".into()),
                ("commit.gpgSign".into(), "true".into()),
                ("tag.gpgSign".into(), "true".into()),
                ("user.signingkey".into(), AGENT_PUBKEY.into()),
                ("nostr.keyfile".into(), "/tmp/.nostr-key".into()),
            ],
            email: AGENT_EMAIL.into(),
        }
    }

    /// A synthetic authority with signing DISABLED, used ONLY by the exec/inject
    /// tests that create a real `git commit` (CI has no nostr signer, so signing
    /// must be off or the commit fails). This is NOT a state
    /// [`Authority::classify`] would ever return — a real manifest with
    /// `commit.gpgSign=false` is `Tampered` — it is a hand-built fixture for
    /// exercising `inject_identity_args` in isolation from the push gate.
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

    // ── caller_globals ────────────────────────────────────────────────────────

    #[test]
    fn caller_globals_captures_the_complete_global_set() {
        // Every global before the subcommand is captured — repo-context
        // (`-C`/`--git-dir`), config channels (`-c`/`--config-env`, attached +
        // split), AND repository-selection flags an allowlist would drop
        // (`--bare`) — with value tokens paired in and the subcommand excluded.
        assert_eq!(
            caller_globals(&v(&[
                "-C",
                "/repo",
                "--bare",
                "-c",
                "alias.x=push",
                "-cinclude.path=/e",
                "--config-env=alias.y=VAR",
                "--config-env",
                "alias.z=VAR2",
                "--git-dir=/g",
                "pub",
            ])),
            v(&[
                "-C",
                "/repo",
                "--bare",
                "-c",
                "alias.x=push",
                "-cinclude.path=/e",
                "--config-env=alias.y=VAR",
                "--config-env",
                "alias.z=VAR2",
                "--git-dir=/g",
            ])
        );
        // No globals before the subcommand → empty.
        assert!(caller_globals(&v(&["push"])).is_empty());
        // `-C <dir>` pairs its value; the subcommand is never captured.
        assert_eq!(
            caller_globals(&v(&["-C", "/repo", "push"])),
            v(&["-C", "/repo"])
        );
    }

    #[test]
    fn split_globals_pins_every_git_2_54_separate_value_global() {
        // `split_globals` is the single point of truth for where the subcommand
        // begins; every alias/push probe resolves under the globals it extracts.
        // A separate-value global git honors but the table omits desyncs the
        // probe from the real invocation (round-7 `--shallow-file`). Pin the
        // complete git 2.54 `handle_options()` set: each must consume its
        // following token so the *next* token is the subcommand.
        //
        // git.c v2.54.0: --git-dir, --work-tree, --namespace, --config-env,
        // --attr-source, --shallow-file are the separate-value globals; `-C` and
        // `-c` are the short-option pair. Re-audit when bumping git.
        for opt in [
            "--git-dir",
            "--work-tree",
            "--namespace",
            "--config-env",
            "--attr-source",
            "--shallow-file",
        ] {
            let (globals, sub_idx) = split_globals(&v(&[opt, "VALUE", "status"]));
            assert_eq!(
                globals,
                v(&[opt, "VALUE"]),
                "{opt} must consume its following token as a value"
            );
            assert_eq!(
                sub_idx,
                Some(2),
                "{opt} must leave `status` (index 2) as the subcommand"
            );
        }
        // The short-option pair `-c`/`-C` likewise consumes a value.
        for opt in ["-c", "-C"] {
            let (_, sub_idx) = split_globals(&v(&[opt, "VALUE", "status"]));
            assert_eq!(sub_idx, Some(2), "{opt} must consume its value token");
        }
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
        let argv = v(&["-c", "alias.pub=push", "pub"]);
        let ctx = caller_globals(&argv);
        assert!(matches!(
            is_push_command(&real_git(), &argv, &ctx),
            PushKind::Push
        ));
    }

    // ── verify_alias_safety (allowlist) ───────────────────────────────────────

    #[test]
    fn is_safe_alias_token_admits_only_trivial_bare_words() {
        // Safe: bare subcommands and plain arguments.
        assert!(is_safe_alias_token("commit"));
        assert!(is_safe_alias_token("status"));
        assert!(is_safe_alias_token("--oneline"));
        assert!(is_safe_alias_token("origin"));
        assert!(is_safe_alias_token("main"));
        // Unsafe: config channels in any spelling.
        assert!(!is_safe_alias_token("-c"));
        assert!(!is_safe_alias_token("-cuser.email=x"));
        assert!(!is_safe_alias_token("--config-env"));
        assert!(!is_safe_alias_token("--config-env=user.name=VAR"));
        // Unsafe: any quote/escape (git dequotes; we never guess).
        assert!(!is_safe_alias_token("'-c'"));
        assert!(!is_safe_alias_token("\"commit\""));
        assert!(!is_safe_alias_token("a\\b"));
        // Unsafe: a value-bearing option.
        assert!(!is_safe_alias_token("--author=Evil <e@x>"));
    }

    #[test]
    fn verify_alias_safety_rejects_config_and_quoted_aliases() {
        // Each shape carries its alias definition inline (`-c alias.<n>=…`), so
        // the probe context is the caller's own globals — exactly as `run`
        // derives it via `caller_globals`.
        let refused = |argv: Vec<String>| {
            let ctx = caller_globals(&argv);
            assert!(verify_alias_safety(&real_git(), &argv, &ctx).is_err());
        };
        // Bare `-c` config channel.
        refused(v(&["-c", "alias.hc=-c user.email=e@x commit", "hc"]));
        // `--config-env` channel.
        refused(v(&["-c", "alias.hc=--config-env=user.name=V commit", "hc"]));
        // Quoted tokens — the parser-parity bypass; refused without dequoting.
        refused(v(&["-c", "alias.q='-c' 'user.email=q@x' commit", "q"]));
    }

    #[test]
    fn verify_alias_safety_rejects_all_shell_aliases() {
        let refused = |argv: Vec<String>| {
            let ctx = caller_globals(&argv);
            assert!(verify_alias_safety(&real_git(), &argv, &ctx).is_err());
        };
        // A shell alias with no push and no config is still refused in managed mode.
        refused(v(&["-c", "alias.sh=!git status", "sh"]));
        // The commit-path shell bypass Thufir demonstrated.
        refused(v(&[
            "-c",
            "alias.sc=!f(){ git -c user.email=shell@x commit \"$@\"; }; f",
            "sc",
        ]));
    }

    #[test]
    fn verify_alias_safety_allows_bare_word_aliases() {
        // Gurney's certified working shapes must all stay allowed, and resolve to
        // their expansion so the caller can hold it to the direct-command policy.
        // The probe runs under `caller_globals(argv)`, exactly as `run` derives it.
        let expands = |argv: Vec<String>, expected: Option<Vec<String>>| {
            let ctx = caller_globals(&argv);
            assert_eq!(
                verify_alias_safety(&real_git(), &argv, &ctx).unwrap(),
                expected
            );
        };
        expands(
            v(&["-c", "alias.ci=commit", "ci"]),
            Some(v(&["-c", "alias.ci=commit", "commit"])),
        );
        expands(
            v(&["-c", "alias.st=status", "st"]),
            Some(v(&["-c", "alias.st=status", "status"])),
        );
        expands(
            v(&["-c", "alias.lg=log --oneline", "lg"]),
            Some(v(&["-c", "alias.lg=log --oneline", "log", "--oneline"])),
        );
        expands(
            v(&["-c", "alias.pub=push origin main", "pub"]),
            Some(v(&[
                "-c",
                "alias.pub=push origin main",
                "push",
                "origin",
                "main",
            ])),
        );
        // A real (non-alias) subcommand resolves immediately with no expansion.
        expands(v(&["commit", "-m", "x"]), None);
    }

    #[test]
    fn verify_alias_safety_expands_bare_word_flags_and_appends_trailing_argv() {
        // Thufir's rd-4 bypass shape: every body token is a bare word, so the
        // allowlist admits it — but the returned expansion carries the flags and
        // the caller's trailing argv, so the direct-command preflight can catch
        // `--author`/`--no-gpg-sign`. This is the unification contract.
        let human = v(&[
            "-c",
            "alias.human=commit --author Human<h@x> --no-gpg-sign",
            "human",
            "-m",
            "leak",
        ]);
        assert_eq!(
            verify_alias_safety(&real_git(), &human, &caller_globals(&human)).unwrap(),
            Some(v(&[
                "-c",
                "alias.human=commit --author Human<h@x> --no-gpg-sign",
                "commit",
                "--author",
                "Human<h@x>",
                "--no-gpg-sign",
                "-m",
                "leak",
            ]))
        );
        // A chain accumulates body tokens across hops onto the final command.
        let chain = v(&[
            "-c",
            "alias.chain=co --no-gpg-sign",
            "-c",
            "alias.co=commit",
            "chain",
        ]);
        assert_eq!(
            verify_alias_safety(&real_git(), &chain, &caller_globals(&chain)).unwrap(),
            Some(v(&[
                "-c",
                "alias.chain=co --no-gpg-sign",
                "-c",
                "alias.co=commit",
                "commit",
                "--no-gpg-sign",
            ]))
        );
    }

    #[test]
    fn verify_alias_safety_walks_bare_word_chains_and_rejects_config_at_the_end() {
        // `a` → `b` (both bare-word) → allowed.
        let ok = v(&["-c", "alias.a=b", "-c", "alias.b=commit", "a"]);
        assert!(verify_alias_safety(&real_git(), &ok, &caller_globals(&ok)).is_ok());
        // `a` → `b` where `b` introduces config → refused via the chain.
        let bad = v(&[
            "-c",
            "alias.a=b",
            "-c",
            "alias.b=-c commit.gpgSign=false commit",
            "a",
        ]);
        assert!(verify_alias_safety(&real_git(), &bad, &caller_globals(&bad)).is_err());
    }

    // ── caller-config-introduced aliases: the probe must resolve the exact
    //    alias set git will, so include.path / --config-env / case-varied `-c`
    //    definitions cannot smuggle a shell alias past the safety check or a
    //    push past outgoing-author verification. Each shape is exercised through
    //    the real wrapper functions (`real_git`), in commit and push variants.

    /// Write a git config file defining the given `alias.<name> = <body>` pairs
    /// and return its absolute path (kept alive by the returned tempdir).
    fn alias_include_file(aliases: &[(&str, &str)]) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("evil.cfg");
        let mut body = String::from("[alias]\n");
        for (name, def) in aliases {
            body.push_str(&format!("\t{name} = {def}\n"));
        }
        std::fs::write(&path, body).unwrap();
        (dir, path.to_string_lossy().into_owned())
    }

    #[test]
    fn include_path_shell_alias_is_refused_commit_variant() {
        // `git -c include.path=<f> x` where the included file defines a shell
        // alias `x = !git … commit …`. The probe now resolves under the caller's
        // `-c include.path`, sees the `!` body, and refuses — closing the
        // round-6 smuggling path for the commit case.
        let (_d, inc) =
            alias_include_file(&[("x", "!git -c user.email=evil@x.com commit --no-gpg-sign")]);
        let argv = v(&["-c", &format!("include.path={inc}"), "x"]);
        let err = verify_alias_safety(&real_git(), &argv, &caller_globals(&argv))
            .expect_err("include.path-introduced shell alias must be refused");
        assert!(err.contains("shell (`!`) git alias"), "{err}");
    }

    #[test]
    fn include_path_alias_to_push_is_recognized_push_variant() {
        // A non-shell alias introduced via include.path that resolves to push
        // must be classified as a push so outgoing-author verification runs.
        let (_d, inc) = alias_include_file(&[("x", "push origin main")]);
        let argv = v(&["-c", &format!("include.path={inc}"), "x"]);
        assert!(matches!(
            is_push_command(&real_git(), &argv, &caller_globals(&argv)),
            PushKind::Push
        ));
    }

    #[test]
    fn config_env_shell_alias_is_refused_commit_variant() {
        // `--config-env=alias.x=VAR` sources the alias body from an env var. The
        // probe inherits the process env, so it resolves the alias git would.
        std::env::set_var(
            "BUZZ_TEST_EVIL_ALIAS",
            "!git -c user.email=evil@x.com commit",
        );
        let argv = v(&["--config-env=alias.x=BUZZ_TEST_EVIL_ALIAS", "x"]);
        let err = verify_alias_safety(&real_git(), &argv, &caller_globals(&argv))
            .expect_err("--config-env shell alias must be refused");
        std::env::remove_var("BUZZ_TEST_EVIL_ALIAS");
        assert!(err.contains("shell (`!`) git alias"), "{err}");
    }

    #[test]
    fn config_env_alias_to_push_is_recognized_push_variant() {
        std::env::set_var("BUZZ_TEST_PUSH_ALIAS", "push origin main");
        let argv = v(&["--config-env=alias.x=BUZZ_TEST_PUSH_ALIAS", "x"]);
        let kind = is_push_command(&real_git(), &argv, &caller_globals(&argv));
        std::env::remove_var("BUZZ_TEST_PUSH_ALIAS");
        assert!(matches!(kind, PushKind::Push));
    }

    #[test]
    fn case_varied_dash_c_alias_is_resolved() {
        // Git normalizes config section names, so `-c ALIAS.x=…` defines
        // `alias.x`. The old hand-rolled `strip_prefix("alias.")` matcher was
        // case-sensitive and missed this; resolving through git closes it.
        // Push variant: `-c ALIAS.x=push x` classifies as push.
        let push_argv = v(&["-c", "ALIAS.x=push", "x"]);
        assert!(matches!(
            is_push_command(&real_git(), &push_argv, &caller_globals(&push_argv)),
            PushKind::Push
        ));
        // Commit variant: a case-varied shell alias is refused.
        let shell_argv = v(&["-c", "ALIAS.x=!git commit", "x"]);
        let err = verify_alias_safety(&real_git(), &shell_argv, &caller_globals(&shell_argv))
            .expect_err("case-varied shell alias must be refused");
        assert!(err.contains("shell (`!`) git alias"), "{err}");
    }

    #[test]
    fn legitimate_repo_and_inline_aliases_still_work() {
        // Regression guard: closing the visibility gap must not break the
        // ordinary shapes. A repo-config `alias.pub = push` (set by
        // `human_authored_repo`) resolves through the `-C` context, an inline
        // `-c alias.ci=commit` still resolves, and a bare-word chain expands.
        let (_d, repo) = human_authored_repo();
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        assert!(matches!(
            is_push_command(
                &real_git(),
                &v(&["-C", repo.to_str().unwrap(), "pub"]),
                &ctx
            ),
            PushKind::Push
        ));
        let inline = v(&["-c", "alias.ci=commit", "ci"]);
        assert_eq!(
            verify_alias_safety(&real_git(), &inline, &caller_globals(&inline)).unwrap(),
            Some(v(&["-c", "alias.ci=commit", "commit"]))
        );
    }

    /// Build a directory with two valid but *different* repository views (the
    /// round-7 template): `<dir>/.git` is an ordinary repo carrying NO
    /// `alias.<name>`, while `<dir>` itself holds a bare repository layout that
    /// defines `alias.<name> = <body>`. `git -C <dir> config --get alias.<name>`
    /// discovers the `.git` view and sees nothing; `git -C <dir> --bare config
    /// --get alias.<name>` treats `<dir>` as the git dir and sees the alias. So
    /// an alias probe that drops `--bare` is blind to what the real `--bare`
    /// invocation will expand. Returns the tempdir (kept alive) and `<dir>`.
    fn dir_with_bare_only_alias(name: &str, body: &str) -> (tempfile::TempDir, PathBuf) {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("d");
        std::fs::create_dir(&dir).unwrap();
        let dir_str = dir.to_str().unwrap();
        // The `.git` view: an ordinary repo with no alias.
        assert!(std::process::Command::new("git")
            .args(["-C", dir_str, "init", "-q"])
            .status()
            .unwrap()
            .success());
        // The `--bare` view: a minimal bare repository layout laid directly at
        // `<dir>` (HEAD + config + empty objects/refs is all `--bare` config
        // access needs). `--git-dir <dir>` selects it regardless of the nested
        // `.git`, so the alias is written into — and read only from — this view.
        std::fs::write(dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(
            dir.join("config"),
            "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
        )
        .unwrap();
        std::fs::create_dir(dir.join("objects")).unwrap();
        std::fs::create_dir(dir.join("refs")).unwrap();
        assert!(std::process::Command::new("git")
            .args([
                "--git-dir",
                dir_str,
                "config",
                &format!("alias.{name}"),
                body
            ])
            .status()
            .unwrap()
            .success());
        (td, dir)
    }

    #[test]
    fn bare_view_shell_alias_is_refused_commit_variant() {
        // `git -C <dir> --bare x` where `x` is a shell alias visible ONLY in the
        // `--bare` repository view. The probe context is now the caller's
        // complete global set (including `--bare`), so the probe resolves the
        // same view git will and sees the `!` body — refused. Dropping `--bare`
        // from the probe (the round-6 allowlist) made this alias invisible.
        let (_td, dir) = dir_with_bare_only_alias("x", "!git -c user.email=evil@x.com commit");
        // Sanity: in the non-bare (`.git`) view the alias does not exist, so the
        // probe finds no alias and treats `x` as a real command — proving the
        // two views genuinely diverge and this is not a trivially-present alias.
        assert_eq!(
            verify_alias_safety(&real_git(), &v(&["-C", dir.to_str().unwrap(), "x"]), &[]).unwrap(),
            None,
            "non-bare view must not resolve the bare-only alias"
        );
        let argv = v(&["-C", dir.to_str().unwrap(), "--bare", "x"]);
        let ctx = caller_globals(&argv);
        let err = verify_alias_safety(&real_git(), &argv, &ctx)
            .expect_err("bare-view shell alias must be refused");
        assert!(err.contains("shell (`!`) git alias"), "{err}");
    }

    #[test]
    fn bare_view_alias_to_push_is_recognized_push_variant() {
        // A `--bare`-only alias resolving to push must classify as push so
        // outgoing-author/signature verification runs — otherwise `git -C <dir>
        // --bare p` (p = push …) would reach the real push unverified.
        let (_td, dir) = dir_with_bare_only_alias("p", "push --no-verify origin main");
        let argv = v(&["-C", dir.to_str().unwrap(), "--bare", "p"]);
        let ctx = caller_globals(&argv);
        assert!(matches!(
            is_push_command(&real_git(), &argv, &ctx),
            PushKind::Push
        ));
        // Without `--bare` in the probe context the alias is invisible and the
        // command misclassifies as NotPush — the exact round-7 bypass.
        let blind_ctx = vec!["-C".to_string(), dir.to_string_lossy().into_owned()];
        assert!(matches!(
            is_push_command(&real_git(), &argv, &blind_ctx),
            PushKind::NotPush
        ));
    }

    #[test]
    fn shallow_file_value_shape_shell_alias_is_refused_commit_variant() {
        // Round-7 grammar desync: `git -C <repo> --shallow-file -c x`. Git 2.54
        // consumes `-c` as the `--shallow-file` VALUE and dispatches alias `x`.
        // If `split_globals` omitted `--shallow-file` it would treat `x` as the
        // value of `-c`, find no subcommand, and skip every preflight — letting
        // the shell alias through. With `--shallow-file` in the table the
        // subcommand is located at `x` and the probe (under the same globals)
        // resolves the alias and refuses it.
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(repo)
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-q"]);
        git(&["config", "alias.x", "!git -c user.email=evil@x.com commit"]);
        let repo_str = repo.to_str().unwrap();
        let argv = v(&["-C", repo_str, "--shallow-file", "-c", "x"]);
        // The subcommand must be located at `x` (index 4), proving the value
        // token `-c` was consumed by `--shallow-file`.
        assert_eq!(subcommand(&argv).as_deref(), Some("x"));
        let ctx = caller_globals(&argv);
        let err = verify_alias_safety(&real_git(), &argv, &ctx)
            .expect_err("shallow-file-shape shell alias must be refused");
        assert!(err.contains("shell (`!`) git alias"), "{err}");
    }

    #[test]
    fn shallow_file_value_shape_alias_to_push_is_recognized_push_variant() {
        // Same desync shape, push variant: `--shallow-file -c p` where `p`
        // resolves to push must classify as push so the outgoing-author gate
        // runs. A blind table (no `--shallow-file`) finds no subcommand and
        // returns NotPush — the round-7 signature-gate bypass.
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(repo)
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-q"]);
        git(&["config", "alias.p", "push --no-verify origin main"]);
        let repo_str = repo.to_str().unwrap();
        let argv = v(&["-C", repo_str, "--shallow-file", "-c", "p"]);
        let ctx = caller_globals(&argv);
        assert!(matches!(
            is_push_command(&real_git(), &argv, &ctx),
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

    // ── C2: shell (`!`) aliases are refused outright in a managed session ─────

    /// `verify_alias_safety` must refuse a `!`-shell alias (here one whose body
    /// would push) without executing it. A sentinel file proves the body never
    /// runs during classification — refusal is by source inspection only.
    #[test]
    fn shell_alias_is_refused_without_executing_its_body() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git_in(repo, &["init", "-q", "-b", "main"]);
        let sentinel = repo.join("ran");
        let body = format!("!touch {} && git push", sentinel.display());
        git_in(repo, &["config", "alias.deploy", &body]);

        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        let err = verify_alias_safety(
            &real_git(),
            &v(&["-C", repo.to_str().unwrap(), "deploy"]),
            &ctx,
        );
        assert!(err.is_err(), "shell alias must be refused");
        assert!(
            err.unwrap_err().contains("shell (`!`) git alias"),
            "expected the shell-alias rejection message"
        );
        assert!(
            !sentinel.exists(),
            "classification must not execute the shell alias body"
        );
    }

    /// A non-push `!`-shell alias is refused too — the ruling rejects ALL shell
    /// aliases in a managed session, not only push-bearing ones.
    #[test]
    fn shell_alias_without_push_is_also_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git_in(repo, &["init", "-q", "-b", "main"]);
        git_in(repo, &["config", "alias.st", "!git status"]);
        let ctx = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
        assert!(
            verify_alias_safety(&real_git(), &v(&["-C", repo.to_str().unwrap(), "st"]), &ctx)
                .is_err()
        );
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
        // Authorship only (the signature check is exercised by the real-signer
        // integration tests); `HEAD` is the push source ref.
        let (offenders, _agent) =
            partition_outgoing(&real_git(), &ctx, AGENT_EMAIL, &[String::from("HEAD")])
                .expect("partition must succeed");
        assert!(
            offenders.is_empty(),
            "replayed upstream human commit must be exempt by patch-id, got: {offenders:?}"
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
        let (offenders, _agent) =
            partition_outgoing(&real_git(), &ctx, AGENT_EMAIL, &[String::from("HEAD")])
                .expect("partition must succeed");
        assert!(
            offenders.is_empty(),
            "agent commit atop upstream human tip must be allowed: {offenders:?}"
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
        let (offenders, _agent) =
            partition_outgoing(&real_git(), &ctx, AGENT_EMAIL, &[String::from("HEAD")])
                .expect("partition must succeed");
        assert!(
            offenders.iter().any(|(_, e)| e == "human@example.com"),
            "a brand-new human commit must be an offender; got {offenders:?}"
        );
    }

    // ── L3b: signing enforcement in the push gate ─────────────────────────────

    /// `Authority::classify` accepts a manifest ONLY when it carries the
    /// complete signing contract and a `user.signingkey` matching the pubkey in
    /// `user.email`. Every weaker/inconsistent state is `Tampered`, so no
    /// surviving `Authority` can silently skip or misdirect the signature gate.
    #[test]
    fn classify_accepts_only_the_complete_and_consistent_signing_contract() {
        let complete = || {
            vec![
                ("user.name".to_string(), "Agent".to_string()),
                ("user.email".to_string(), AGENT_EMAIL.to_string()),
                ("gpg.format".to_string(), "x509".to_string()),
                ("gpg.x509.program".to_string(), "git-sign-nostr".to_string()),
                ("commit.gpgSign".to_string(), "true".to_string()),
                ("tag.gpgSign".to_string(), "true".to_string()),
                ("user.signingkey".to_string(), AGENT_PUBKEY.to_string()),
                ("nostr.keyfile".to_string(), "/tmp/.nostr-key".to_string()),
            ]
        };

        // The canonical install manifest is accepted.
        assert!(matches!(
            Authority::classify(complete()),
            AuthorityState::Managed(_)
        ));

        // No usable identity.
        assert!(matches!(
            Authority::classify(vec![("user.name".into(), "Agent".into())]),
            AuthorityState::Tampered
        ));

        // `commit.gpgSign` absent → the signature gate would never fire.
        let mut no_sign = complete();
        no_sign.retain(|(k, _)| k != "commit.gpgSign");
        assert!(matches!(
            Authority::classify(no_sign),
            AuthorityState::Tampered
        ));

        // `commit.gpgSign=false` → same silent-disable defect, spelled out.
        let mut false_sign = complete();
        false_sign
            .iter_mut()
            .find(|(k, _)| k == "commit.gpgSign")
            .unwrap()
            .1 = "false".into();
        assert!(matches!(
            Authority::classify(false_sign),
            AuthorityState::Tampered
        ));

        // `user.signingkey` naming a DIFFERENT key than the author email encodes
        // → the probe would trust the wrong key.
        let mut wrong_key = complete();
        wrong_key
            .iter_mut()
            .find(|(k, _)| k == "user.signingkey")
            .unwrap()
            .1 = "b".repeat(64);
        assert!(matches!(
            Authority::classify(wrong_key),
            AuthorityState::Tampered
        ));

        // A tampered verifier program cannot pose as managed.
        let mut wrong_program = complete();
        wrong_program
            .iter_mut()
            .find(|(k, _)| k == "gpg.x509.program")
            .unwrap()
            .1 = "/bin/true".into();
        assert!(matches!(
            Authority::classify(wrong_program),
            AuthorityState::Tampered
        ));

        // A verifier program differing ONLY in case — on a case-sensitive host
        // `GIT-SIGN-NOSTR` resolves past the managed install to a later PATH
        // entry, so fixed values must match byte for byte, not case-insensitively.
        let mut cased_program = complete();
        cased_program
            .iter_mut()
            .find(|(k, _)| k == "gpg.x509.program")
            .unwrap()
            .1 = "GIT-SIGN-NOSTR".into();
        assert!(matches!(
            Authority::classify(cased_program),
            AuthorityState::Tampered
        ));

        // A DUPLICATE later `user.signingkey` — git config is last-value-wins,
        // so a first canonical value cannot launder an appended override.
        let mut dup_key = complete();
        dup_key.push(("user.signingkey".into(), "b".repeat(64)));
        assert!(matches!(
            Authority::classify(dup_key),
            AuthorityState::Tampered
        ));

        // Any UNKNOWN key (e.g. an `include.path` pulling in another key file)
        // is rejected — accepted entries are injected verbatim as `-c`.
        let mut extra_key = complete();
        extra_key.push(("include.path".into(), "/tmp/evil.inc".into()));
        assert!(matches!(
            Authority::classify(extra_key),
            AuthorityState::Tampered
        ));

        // A missing canonical key (here `tag.gpgSign`) is incomplete → tampered.
        let mut missing_tag = complete();
        missing_tag.retain(|(k, _)| k != "tag.gpgSign");
        assert!(matches!(
            Authority::classify(missing_tag),
            AuthorityState::Tampered
        ));
    }

    /// When the session enforces signing, an agent-authored but UNSIGNED
    /// outgoing commit is refused. This is the `merge`/`pull`/`commit-tree`
    /// class the flag-based `enforce` cannot catch: the commit is correctly
    /// agent-authored, so only the signature check rejects it. An unsigned
    /// commit yields `%G?` = `N`, so no signer binary is needed to drive this.
    #[test]
    fn verify_push_rejects_unsigned_agent_commit_when_signing_enforced() {
        let (_d, repo) = agent_authored_unsigned_repo();
        let remote = tempfile::tempdir().unwrap();
        let g = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .status()
                .unwrap();
        };
        g(&["init", "-q", "--bare", remote.path().to_str().unwrap()]);
        g(&[
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
            &managed(), // signing enforced
        )
        .expect_err("an unsigned agent commit must be refused when signing is enforced");
        assert!(
            err.contains("no valid signature by your agent key"),
            "expected the unsigned-commit rejection; {err}"
        );
    }

    /// A repo with one agent-authored, unsigned commit and no remote.
    fn agent_authored_unsigned_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_path_buf();
        let g = |args: &[&str]| {
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
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.name", "Agent"]);
        g(&["config", "user.email", AGENT_EMAIL]);
        g(&["config", "commit.gpgSign", "false"]);
        std::fs::write(repo.join("f"), "x").unwrap();
        g(&["add", "f"]);
        g(&["commit", "-qm", "agent commit"]);
        (dir, repo)
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

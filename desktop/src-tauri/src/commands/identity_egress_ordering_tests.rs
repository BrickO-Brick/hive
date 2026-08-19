// C2 structural tripwire: every direct owner-artifact command that reads
// `state.signing_keys()` must admit before its owner-key read.
//
// The commands take `State<AppState>`, which a `tauri::test` mock cannot swap
// mid-call, so the "clone A's key → pause → transition commits B → admit at
// B" race has no hermetic runtime seam at the command boundary. It is instead
// pinned STRUCTURALLY: `try_admit_owner_identity_egress()` holds a lease that
// `begin_egress_drain` must await before B commits, so a key read that happens
// AFTER admission cannot observe a mid-transition swap. This scan asserts that
// ordering for every command in the C2 set — a future edit that reads
// `signing_keys()` before admitting fails to compile-in the bug because this
// test rejects it. The lease-blocks-the-drain half of the invariant is driven
// at the registry seam in
// `owner_identity_egress::tests::key_read_under_lease_blocks_commit_b`.

/// The owner-key read accessor guarded by admission. `state.signing_keys()` is
/// the sole owner-key clone in the leased commands.
fn key_read_needle() -> String {
    ["signing_", "keys()"].concat()
}

/// The admission call that must precede every key read.
fn admit_needle() -> String {
    ["try_admit_owner_", "identity_egress"].concat()
}

/// The direct owner-artifact commands whose artifacts can be stamped as a
/// post-transition identity if they clone the owner key before admission.
const C2_COMMANDS: &[&str] = &[
    // The C2 artifact-command universe is closed by the owner-artifact inventory
    // in `owner_identity_egress`: every direct producer that reads
    // `state.signing_keys()` must admit before that read. The NIP-49 backup is
    // structurally different — its helper reads under its caller-held
    // `identity_mutation` + admitted lease, which the C3 schedule and helper
    // precondition test pin separately.
    "pub async fn sign_event(",
    "pub async fn decrypt_observer_event(",
    "pub async fn build_observer_control_event(",
    "pub async fn get_nsec(",
    "pub async fn sign_nostr_identity_binding(",
    "pub async fn create_auth_event(",
    "pub async fn nip44_encrypt_to_self(",
    "pub async fn nip44_decrypt_from_self(",
];

/// Split the module source into `(fn signature line, body)` segments at
/// top-level `fn` boundaries (column-0 `fn`, `pub fn`, `pub async fn`,
/// `pub(crate) fn`). Every leased command is a top-level fn, so this bounds
/// each body without a brace parser.
fn top_level_fns(content: &str) -> Vec<(String, String)> {
    let is_fn_decl = |line: &str| {
        line.starts_with("fn ")
            || line.starts_with("pub fn ")
            || line.starts_with("pub async fn ")
            || line.starts_with("pub(crate) fn ")
            || line.starts_with("async fn ")
    };
    let mut segments = Vec::new();
    let mut current: Option<(String, Vec<&str>)> = None;
    for line in content.lines() {
        if is_fn_decl(line) {
            if let Some((sig, body)) = current.take() {
                segments.push((sig, body.join("\n")));
            }
            current = Some((line.to_string(), Vec::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push(line);
        }
    }
    if let Some((sig, body)) = current.take() {
        segments.push((sig, body.join("\n")));
    }
    segments
}

/// First non-comment line index of `needle` in a body, or `None`.
fn first_call(body: &str, needle: &str) -> Option<usize> {
    body.lines().enumerate().find_map(|(i, line)| {
        let trimmed = line.trim_start();
        (!trimmed.starts_with("//") && trimmed.contains(needle)).then_some(i)
    })
}

/// Violations: a command in the C2 set either omits admission or reads the
/// owner key before it admits.
fn admission_ordering_violations(content: &str) -> Vec<String> {
    let key = key_read_needle();
    let admit = admit_needle();
    let mut violations = Vec::new();
    for (sig, body) in top_level_fns(content) {
        if !C2_COMMANDS.iter().any(|command| sig.contains(command)) {
            continue;
        }
        let Some(admit_at) = first_call(&body, &admit) else {
            violations.push(format!(
                "{}: C2 command must admit before reading {key}",
                sig.trim()
            ));
            continue;
        };
        let Some(key_at) = first_call(&body, &key) else {
            violations.push(format!(
                "{}: C2 command must read {key} under its admission lease",
                sig.trim()
            ));
            continue;
        };
        if key_at < admit_at {
            violations.push(format!(
                "{}: reads {key} at body line {} but admits the lease at body line {} — \
                 admission MUST precede every owner-key read (C2)",
                sig.trim(),
                key_at + 1,
                admit_at + 1,
            ));
        }
    }
    violations
}

fn module_source() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/identity.rs");
    std::fs::read_to_string(path).unwrap()
}

/// Every leased owner-identity command admits before it reads the owner key.
#[test]
fn leased_commands_admit_before_reading_the_owner_key() {
    let violations = admission_ordering_violations(&module_source());
    assert!(
        violations.is_empty(),
        "owner-key read precedes admission — a captured pre-transition key can be \
         stamped as the post-transition generation (C2). Admit first:\n{}",
        violations.join("\n")
    );
}

/// Mutation proof: reordering a command back to read-then-admit trips the scan.
#[test]
fn scan_catches_a_read_before_admit() {
    let content = format!(
        "pub async fn sign_event(state: State) {{\n    \
         let keys = state.{}?;\n    \
         let lease = crate::owner_identity_egress::{}().await?;\n}}\n",
        key_read_needle(),
        admit_needle(),
    );
    let violations = admission_ordering_violations(&content);
    assert!(
        violations.iter().any(|v| v.contains("sign_event")),
        "a read-before-admit command must trip the scan: {violations:?}"
    );
}

/// The helper's caller holds `identity_mutation` plus the admitted lease;
/// its internal key read is not itself a command-admission boundary and must
/// not register as a C2 violation.
#[test]
fn scan_ignores_non_leased_key_readers() {
    let content = format!(
        "pub(crate) fn create_backup_with_log_n(state: &AppState) {{\n    \
         let _guard = state.identity_mutation.blocking_lock();\n    \
         let keys = state.{}?;\n}}\n",
        key_read_needle(),
    );
    assert!(
        admission_ordering_violations(&content).is_empty(),
        "a key reader that never admits a lease is out of C2 scope"
    );
}

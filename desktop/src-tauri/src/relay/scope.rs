use super::relay_http_base_url;

/// Fail closed when a caller-captured relay scope no longer matches the
/// relay a command actually resolved.
///
/// Long-lived UI callbacks (e.g. the Projects agent submit flow) capture the
/// community relay before their first await; a workspace switch during that
/// await would otherwise retarget the eventual publication to the new
/// tenant's relay. Callers pass the captured scope as a ws(s) URL; it is
/// normalized through [`relay_http_base_url`] and compared against the base
/// the command resolved once and uses for every side effect. `None` preserves
/// the unscoped behavior for callers without a tenant boundary.
pub fn assert_expected_relay_scope(
    expected_relay_url: Option<&str>,
    resolved_api_base_url: &str,
) -> Result<(), String> {
    let Some(expected) = expected_relay_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let expected_base = relay_http_base_url(expected);
    if expected_base != resolved_api_base_url.trim().trim_end_matches('/') {
        return Err(
            "active community changed before the message was submitted; not sent".to_string(),
        );
    }
    Ok(())
}

/// Fail closed when a caller-captured signer identity no longer matches the
/// identity a command actually read.
///
/// The relay URL and the signing keys live under separate locks and a
/// workspace switch mutates them in sequence, so a caller that only pins the
/// relay can still have its event signed — and its NIP-98 auth minted — by
/// the *new* tenant's identity if the switch lands between the URL check and
/// the key read. Callers capture the expected owner pubkey together with the
/// relay scope; commands read one identity snapshot, assert it here, and use
/// that exact snapshot for every signature. `None` preserves the unscoped
/// behavior for callers without a tenant boundary.
pub fn assert_expected_signer(
    expected_signer_pubkey: Option<&str>,
    actual_signer_hex: &str,
) -> Result<(), String> {
    let Some(expected) = expected_signer_pubkey
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };
    if !expected.eq_ignore_ascii_case(actual_signer_hex) {
        return Err(
            "active identity changed before the message was submitted; not sent".to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{assert_expected_relay_scope, assert_expected_signer};

    #[test]
    fn matching_scope_passes_across_ws_http_normalization() {
        assert_expected_relay_scope(Some("wss://tenant-a.example"), "https://tenant-a.example")
            .unwrap();
        assert_expected_relay_scope(Some("ws://localhost:3000"), "http://localhost:3000").unwrap();
        // Trailing-slash and whitespace tolerance mirrors relay_http_base_url.
        assert_expected_relay_scope(
            Some(" wss://tenant-a.example/ "),
            "https://tenant-a.example/",
        )
        .unwrap();
    }

    #[test]
    fn changed_scope_fails_closed() {
        let error =
            assert_expected_relay_scope(Some("wss://tenant-a.example"), "https://tenant-b.example")
                .unwrap_err();
        assert!(error.contains("active community changed"), "{error}");
    }

    #[test]
    fn absent_scope_preserves_unscoped_sends() {
        assert_expected_relay_scope(None, "https://anything.example").unwrap();
        assert_expected_relay_scope(Some(""), "https://anything.example").unwrap();
        assert_expected_relay_scope(Some("   "), "https://anything.example").unwrap();
    }

    #[test]
    fn matching_signer_passes_case_insensitively() {
        let keys = nostr::Keys::generate();
        let hex = keys.public_key().to_hex();
        assert_expected_signer(Some(&hex), &hex).unwrap();
        assert_expected_signer(Some(&hex.to_ascii_uppercase()), &hex).unwrap();
        assert_expected_signer(Some(&format!("  {hex} ")), &hex).unwrap();
    }

    #[test]
    fn changed_signer_fails_closed() {
        // Models the workspace-switch race: the caller captured tenant A's
        // owner identity, but the switch landed before the command read the
        // keys, so the snapshot now holds tenant B's identity.
        let captured = nostr::Keys::generate().public_key().to_hex();
        let switched = nostr::Keys::generate().public_key().to_hex();
        let error = assert_expected_signer(Some(&captured), &switched).unwrap_err();
        assert!(error.contains("active identity changed"), "{error}");
    }

    #[test]
    fn absent_signer_preserves_unscoped_sends() {
        let hex = nostr::Keys::generate().public_key().to_hex();
        assert_expected_signer(None, &hex).unwrap();
        assert_expected_signer(Some(""), &hex).unwrap();
        assert_expected_signer(Some("   "), &hex).unwrap();
    }
}

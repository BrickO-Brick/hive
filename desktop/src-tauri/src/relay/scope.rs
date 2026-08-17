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

#[cfg(test)]
mod tests {
    use super::assert_expected_relay_scope;

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
}

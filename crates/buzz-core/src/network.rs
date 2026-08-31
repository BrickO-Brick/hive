//! Network utility functions for Buzz.
//!
//! Provides shared helpers used across crates for SSRF protection and
//! IP address classification.

// RFC 6052 well-known NAT64 prefix (64:ff9b::/96).
const NAT64_WELL_KNOWN_PREFIX: [u8; 12] = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];

// Legacy SIIT IPv4-translated prefix (::ffff:0:0:0/96).
const IPV4_TRANSLATED_PREFIX: [u8; 12] = [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0];

/// Extract an IPv4 address stored in the final four octets under a `/96` prefix.
///
/// Using network-order octets directly avoids error-prone segment shifting.
fn embedded_ipv4(v6: &std::net::Ipv6Addr, prefix: &[u8; 12]) -> Option<std::net::Ipv4Addr> {
    let octets = v6.octets();
    octets
        .starts_with(prefix)
        .then(|| std::net::Ipv4Addr::new(octets[12], octets[13], octets[14], octets[15]))
}

/// Returns `true` if the address is not a globally reachable public unicast
/// address — i.e., it falls within any IANA special-purpose range that is not
/// marked "Globally Reachable" in the IANA IPv4/IPv6 Special-Purpose Address
/// Registries (2024). Used for SSRF protection: outbound targets must resolve
/// only to publicly routable space.
///
/// Source: IANA IPv4 Special-Purpose Address Registry (2024-02) and
///         IANA IPv6 Special-Purpose Address Registry (2024-02).
///
/// Non-globally-reachable ranges blocked:
///
/// IPv4
/// - 0.0.0.0/8          RFC 1122 — "This" host
/// - 10.0.0.0/8         RFC 1918 — private use
/// - 100.64.0.0/10      RFC 6598 — shared address space (CGNAT)
/// - 127.0.0.0/8        RFC 1122 — loopback
/// - 169.254.0.0/16     RFC 3927 — link-local
/// - 172.16.0.0/12      RFC 1918 — private use
/// - 192.0.0.0/24       RFC 6890 — IETF protocol assignments
///                      (exceptions: 192.0.0.9 PCP anycast, 192.0.0.10 TURN anycast)
/// - 192.0.2.0/24       RFC 5737 — documentation TEST-NET-1
/// - 192.88.99.0/24     RFC 7526 — deprecated 6to4 relay anycast
/// - 192.168.0.0/16     RFC 1918 — private use
/// - 198.18.0.0/15      RFC 2544 — network benchmarking
/// - 198.51.100.0/24    RFC 5737 — documentation TEST-NET-2
/// - 203.0.113.0/24     RFC 5737 — documentation TEST-NET-3
/// - 224.0.0.0/4        RFC 1112 — multicast
/// - 240.0.0.0/4        RFC 1112 — reserved/future use
/// - 255.255.255.255/32 RFC 919  — limited broadcast
///
/// IPv6
/// - ::/128             RFC 4291 — unspecified
/// - ::1/128            RFC 4291 — loopback
/// - ::ffff:0:0/96      RFC 4291 — IPv4-mapped (embedded IPv4 checked recursively)
/// - ::ffff:0:0:0/96    RFC 6145 — IPv4-translated SIIT (embedded IPv4 checked)
/// - 64:ff9b::/96       RFC 6052 — NAT64 well-known (embedded IPv4 checked)
/// - 64:ff9b:1::/48     RFC 8215 — local-use NAT64
/// - 100::/64           RFC 6666 — discard-only
/// - 2001::/32          RFC 4380 — Teredo
/// - 2001:2::/48        RFC 5180 — benchmarking
/// - 2001:20::/28       RFC 7343 — ORCHIDv2
/// - 2001:db8::/32      RFC 3849 — documentation
/// - 2002::/16          RFC 3056 — 6to4 (deprecated)
/// - fc00::/7           RFC 4193 — ULA
/// - fe80::/10          RFC 4291 — link-local
/// - ff00::/8           RFC 4291 — multicast
pub fn is_not_global_unicast(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || o[0] == 0                                           // 0.0.0.0/8
                || v4.is_broadcast()                                   // 255.255.255.255
                || (o[0] == 100 && (o[1] & 0xC0) == 64)               // 100.64.0.0/10 CGNAT
                || (o[0] == 198 && (o[1] & 0xFE) == 18)               // 198.18.0.0/15 benchmarking
                || (o[0] & 0xF0) == 0xE0                              // 224.0.0.0/4 multicast
                || (o[0] & 0xF0) == 0xF0                              // 240.0.0.0/4 reserved
                // 192.0.0.0/24 IETF protocol assignments — not globally reachable
                // except 192.0.0.9 (PCP anycast, RFC 7723) and 192.0.0.10 (TURN anycast, RFC 8155).
                || (o[0] == 192 && o[1] == 0 && o[2] == 0 && o[3] != 9 && o[3] != 10)
                || (o[0] == 192 && o[1] == 0 && o[2] == 2)            // 192.0.2.0/24 TEST-NET-1
                || (o[0] == 192 && o[1] == 88 && o[2] == 99)          // 192.88.99.0/24 deprecated 6to4
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)         // 198.51.100.0/24 TEST-NET-2
                || (o[0] == 203 && o[1] == 0 && o[2] == 113) // 203.0.113.0/24 TEST-NET-3
        }
        std::net::IpAddr::V6(v6) => {
            // IPv4-compatible and IPv4-mapped addresses are checked against IPv4 rules.
            if let Some(v4) = v6.to_ipv4() {
                return is_not_global_unicast(&std::net::IpAddr::V4(v4));
            }

            let segments = v6.segments();

            // NAT64 well-known prefix (RFC 6052): reachability determined by the
            // embedded IPv4 address.
            if let Some(v4) = embedded_ipv4(v6, &NAT64_WELL_KNOWN_PREFIX) {
                return is_not_global_unicast(&std::net::IpAddr::V4(v4));
            }

            // SIIT IPv4-translated addresses route to the embedded IPv4 value and
            // are not recognised by `to_ipv4()`.
            if let Some(v4) = embedded_ipv4(v6, &IPV4_TRANSLATED_PREFIX) {
                return is_not_global_unicast(&std::net::IpAddr::V4(v4));
            }

            v6.is_loopback()
                || v6.is_unspecified()
                || segments[0] & 0xfe00 == 0xfc00 // fc00::/7 ULA
                || segments[0] & 0xffc0 == 0xfe80 // fe80::/10 link-local
                || segments[0] & 0xff00 == 0xff00 // ff00::/8 multicast
                // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
                || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 1)
                // 100::/64 discard-only (RFC 6666)
                || (segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0)
                // 2001::/32 Teredo (RFC 4380)
                || (segments[0] == 0x2001 && segments[1] == 0)
                // 2001:2::/48 benchmarking (RFC 5180)
                || (segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0)
                // 2001:20::/28 ORCHIDv2 (RFC 7343): top 28 bits = 2001:002x
                || (segments[0] == 0x2001 && (segments[1] >> 4) == 0x0002)
                // 2001:db8::/32 documentation (RFC 3849)
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || segments[0] == 0x2002 // 2002::/16 6to4 deprecated (RFC 3056)
        }
    }
}

/// Compatibility alias; prefer [`is_not_global_unicast`].
#[inline]
pub fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    is_not_global_unicast(ip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    // ── helpers ──────────────────────────────────────────────────────────────

    fn blocked(s: &str) -> bool {
        is_not_global_unicast(&s.parse::<IpAddr>().unwrap())
    }

    // ── public positive controls ─────────────────────────────────────────────

    #[test]
    fn public_v4_cloudflare() {
        assert!(!blocked("1.1.1.1"));
    }
    #[test]
    fn public_v4_google() {
        assert!(!blocked("8.8.8.8"));
    }
    #[test]
    fn public_v6_cloudflare() {
        assert!(!blocked("2606:4700::1"));
    }

    // ── RFC 1122 loopback / unspecified ──────────────────────────────────────

    #[test]
    fn loopback_v4() {
        assert!(blocked("127.0.0.1"));
    }
    #[test]
    fn loopback_v6() {
        assert!(blocked("::1"));
    }
    #[test]
    fn unspecified_v4() {
        assert!(blocked("0.0.0.0"));
    }
    #[test]
    fn unspecified_v6() {
        assert!(blocked("::"));
    }

    // ── RFC 1918 private use ─────────────────────────────────────────────────

    #[test]
    fn private_10() {
        assert!(blocked("10.0.0.1"));
    }
    #[test]
    fn private_172() {
        assert!(blocked("172.16.0.1"));
    }
    #[test]
    fn private_192_168() {
        assert!(blocked("192.168.1.1"));
    }

    // ── RFC 3927 link-local ───────────────────────────────────────────────────

    #[test]
    fn link_local_v4() {
        assert!(blocked("169.254.1.1"));
    }
    #[test]
    fn link_local_v6() {
        assert!(blocked("fe80::1"));
    }

    // ── RFC 919 broadcast ────────────────────────────────────────────────────

    #[test]
    fn broadcast() {
        assert!(blocked("255.255.255.255"));
    }

    // ── RFC 6598 CGNAT 100.64.0.0/10 ────────────────────────────────────────

    #[test]
    fn cgnat() {
        assert!(blocked("100.64.0.1"));
        assert!(blocked("100.127.255.254"));
        assert!(!blocked("100.63.255.255")); // just below
        assert!(!blocked("100.128.0.0")); // just above
    }

    // ── RFC 2544 benchmarking 198.18.0.0/15 ─────────────────────────────────

    #[test]
    fn benchmarking_v4() {
        assert!(blocked("198.18.0.1"));
        assert!(blocked("198.19.255.254"));
        assert!(!blocked("198.17.255.255")); // just below
        assert!(!blocked("198.20.0.0")); // just above
    }

    // ── RFC 1112 multicast 224.0.0.0/4 ──────────────────────────────────────

    #[test]
    fn multicast_v4() {
        assert!(blocked("224.0.0.0"));
        assert!(blocked("224.0.0.251")); // mDNS
        assert!(blocked("239.255.255.250")); // SSDP
        assert!(blocked("239.255.255.255"));
        assert!(!blocked("223.255.255.255")); // just below
    }

    // ── RFC 1112 reserved 240.0.0.0/4 ───────────────────────────────────────

    #[test]
    fn reserved_v4() {
        assert!(blocked("240.0.0.0"));
        assert!(blocked("254.255.255.255"));
        assert!(!blocked("223.255.255.255")); // just below multicast boundary (also blocked, but distinct)
    }

    // ── RFC 6890 IETF protocol assignments 192.0.0.0/24 ─────────────────────
    // Most of this range is not globally reachable; 192.0.0.9 (PCP anycast,
    // RFC 7723) and 192.0.0.10 (TURN anycast, RFC 8155) are exceptions.

    #[test]
    fn ietf_protocol_assignments() {
        assert!(blocked("192.0.0.0"));
        assert!(blocked("192.0.0.1"));
        assert!(blocked("192.0.0.170")); // NAT64/464XLAT — not globally reachable
        assert!(blocked("192.0.0.255"));
        assert!(!blocked("192.0.0.9")); // PCP anycast (RFC 7723) — globally reachable
        assert!(!blocked("192.0.0.10")); // TURN anycast (RFC 8155) — globally reachable
    }

    // ── RFC 5737 documentation TEST-NET-1/2/3 ────────────────────────────────

    #[test]
    fn documentation_v4() {
        assert!(blocked("192.0.2.0"));
        assert!(blocked("192.0.2.255"));
        assert!(blocked("198.51.100.0"));
        assert!(blocked("198.51.100.255"));
        assert!(blocked("203.0.113.0"));
        assert!(blocked("203.0.113.255"));
        // Adjacent addresses that are routable.
        assert!(!blocked("192.0.1.255"));
        assert!(!blocked("192.0.3.0"));
        assert!(!blocked("198.51.99.255"));
        assert!(!blocked("198.51.101.0"));
        assert!(!blocked("203.0.112.255"));
        assert!(!blocked("203.0.114.0"));
    }

    // ── RFC 7526 deprecated 6to4 relay anycast 192.88.99.0/24 ───────────────

    #[test]
    fn deprecated_6to4_relay_anycast() {
        assert!(blocked("192.88.99.0"));
        assert!(blocked("192.88.99.1"));
        assert!(blocked("192.88.99.255"));
        assert!(!blocked("192.88.98.255")); // just below
        assert!(!blocked("192.88.100.0")); // just above
    }

    // ── RFC 4193 ULA ─────────────────────────────────────────────────────────

    #[test]
    fn ula_v6() {
        assert!(blocked("fd00::1"));
    }

    // ── RFC 3849 documentation 2001:db8::/32 ─────────────────────────────────

    #[test]
    fn documentation_v6() {
        assert!(blocked("2001:db8::1"));
        assert!(blocked("2001:db8:ffff::1"));
    }

    // ── RFC 4291 multicast ff00::/8 ──────────────────────────────────────────

    #[test]
    fn multicast_v6() {
        assert!(blocked("ff02::1")); // all-nodes
        assert!(blocked("ff02::2")); // all-routers
        assert!(blocked("ffff::1"));
        assert!(!blocked("fe00::1")); // just below
    }

    // ── RFC 6666 discard-only 100::/64 ───────────────────────────────────────

    #[test]
    fn discard_only_v6() {
        assert!(blocked("100::1"));
        assert!(blocked("100::ffff:ffff:ffff:ffff"));
        assert!(!blocked("100:0:0:1::1")); // outside /64
    }

    // ── RFC 5180 benchmarking 2001:2::/48 ────────────────────────────────────

    #[test]
    fn benchmarking_v6() {
        assert!(blocked("2001:2::1"));
        assert!(blocked("2001:2:0:ffff:ffff:ffff:ffff:ffff"));
        assert!(!blocked("2001:2:1::1")); // outside /48
    }

    // ── RFC 7343 ORCHIDv2 2001:20::/28 ───────────────────────────────────────

    #[test]
    fn orchid_v6() {
        assert!(blocked("2001:20::1"));
        assert!(blocked("2001:2f::1")); // last /28 prefix
        assert!(!blocked("2001:30::1")); // just outside
        assert!(!blocked("2001:1::1")); // Teredo subdomain, but outside Teredo /32 range
    }

    // ── RFC 4380 Teredo 2001::/32 ────────────────────────────────────────────

    #[test]
    fn teredo_v6() {
        assert!(blocked("2001::"));
        assert!(blocked("2001:0:ffff:ffff:ffff:ffff:ffff:ffff"));
        assert!(!blocked("2001:1::1")); // outside /32
    }

    // ── RFC 3056 6to4 2002::/16 ───────────────────────────────────────────────

    #[test]
    fn six_to_four_v6() {
        assert!(blocked("2002::"));
        assert!(blocked("2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"));
        assert!(!blocked("2003::1")); // outside /16
    }

    // ── RFC 8215 local-use NAT64 64:ff9b:1::/48 ──────────────────────────────

    #[test]
    fn nat64_local_use_v6() {
        assert!(blocked("64:ff9b:1::"));
        assert!(blocked("64:ff9b:1:ffff:ffff:ffff:ffff:ffff"));
        assert!(!blocked("64:ff9b:2::")); // outside /48
    }

    // ── RFC 6052 NAT64 well-known 64:ff9b::/96 ───────────────────────────────
    // Reachability follows the embedded IPv4 address.

    #[test]
    fn nat64_well_known_prefix() {
        let first = "64:ff9b::".parse().unwrap();
        let last = "64:ff9b::ffff:ffff".parse().unwrap();
        assert_eq!(
            embedded_ipv4(&first, &NAT64_WELL_KNOWN_PREFIX),
            Some("0.0.0.0".parse().unwrap())
        );
        assert_eq!(
            embedded_ipv4(&last, &NAT64_WELL_KNOWN_PREFIX),
            Some("255.255.255.255".parse().unwrap())
        );
        assert!(blocked("64:ff9b::10.0.0.1"));
        assert!(blocked("64:ff9b::127.0.0.1"));
        assert!(blocked("64:ff9b::169.254.169.254"));
        assert!(!blocked("64:ff9b::8.8.8.8"));
        assert!(!blocked("64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff")); // different prefix
        assert!(!blocked("64:ff9b::1:0:0")); // outside /96
    }

    // ── SIIT IPv4-translated ::ffff:0:0:0/96 ─────────────────────────────────

    #[test]
    fn ipv4_translated_prefix() {
        assert!(blocked("::ffff:0:10.0.0.1"));
        assert!(blocked("::ffff:0:127.0.0.1"));
        assert!(blocked("::ffff:0:169.254.169.254"));
        assert!(!blocked("::ffff:0:8.8.8.8"));
        assert!(!blocked("0:0:0:0:fffe:ffff:ffff:ffff")); // outside prefix
        assert!(!blocked("0:0:0:0:ffff:1:0:0"));
    }

    // ── IPv4-mapped ::ffff:0:0/96 ─────────────────────────────────────────────

    #[test]
    fn ipv4_mapped_v6() {
        assert!(blocked("::ffff:10.0.0.1"));
        assert!(blocked("::ffff:127.0.0.1"));
        assert!(!blocked("::ffff:8.8.8.8"));
    }

    // ── IPv4-compatible ::/96 ─────────────────────────────────────────────────

    #[test]
    fn ipv4_compatible_v6() {
        assert!(blocked("::10.0.0.1"));
        assert!(blocked("::127.0.0.1"));
        assert!(blocked("::169.254.169.254"));
        assert!(!blocked("::8.8.8.8"));
    }
}

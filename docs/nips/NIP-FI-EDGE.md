# NIP-FI-EDGE: Trusted Edge Profile

`draft` `optional`

> SKELETON — text owner: Perci. Source: RESEARCH/NIP_FI_9999_TRANSPORT_WIRE_DESIGN.md.

## Scope

Registered edge adapters; trusted-proxy-hmac-v2 envelope + canonicalization;
authorization_domain_id derivation (exact 16 RFC 9562 UUID bytes, network order);
proof_transport_code registry + extension procedure; key rotation; nonce replay;
body acquisition bounds (deny-before-hashing, EOF-complete); normative test-vector
suite with full intermediates; proxy provenance traces. Header-trust-without-
provenance is nonconformant.

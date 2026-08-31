//! Compile-fail evidence: the relay NIP-FI authority boundary is
//! compiler-enforced.  Each fixture must fail to compile; trybuild records the
//! actual rustc error as a `.stderr` snapshot.
//!
//! ## Fixtures
//!
//! - `context_sealed_from_external.rs` — proves the `seal_inline` constructor
//!   boundary for `SealedRequestContext`.  The outer `nip_fi` module is private;
//!   if that were dissolved, `seal_inline` is still `pub(super)` (E0624).
//!   Both walls must hold to prevent any external caller from minting a context.
//!
//! - `authority_output_opaque.rs` — proves the authority output token boundary.
//!   `CommittedAuthorization` is `pub(crate)` (wall 2) and all fields are
//!   `pub(super)` (wall 3), on top of the outer module wall (wall 1).  All
//!   three must hold to prevent forgery of committed-authorization tokens.
//!
//! ## Layered wall semantics
//!
//! Both fixtures fail at the outer module wall (`mod nip_fi` is private, E0603).
//! That is the expected — and correct — first failure.  The inner walls
//! (`pub(super)` on `seal_inline`, `pub(crate)` + `pub(super)` on
//! `CommittedAuthorization`) are each independently enforced by the compiler
//! within `buzz_relay`.  Trybuild fixtures always compile from an external-crate
//! perspective, so the outer wall fires first.  What these fixtures prove is:
//!
//! 1. The outer wall exists and has not been accidentally `pub`-ified.
//! 2. The items being tested (seal_inline, CommittedAuthorization fields) are
//!    named explicitly — if either were widened AND the module made pub, the
//!    fixture would compile (turn green), proving the combined boundary broke.
//!
//! The `pub(super)` intra-crate contract for `seal_inline` is additionally
//! documented in `context.rs`: any Rust module inside `buzz_relay` that is
//! NOT `buzz_relay::nip_fi` will receive E0624 if it tries to call `seal_inline`.

#[test]
fn seal_boundary_compile_fail() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/*.rs");
}

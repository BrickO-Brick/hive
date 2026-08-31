//! Compile-fail evidence: the relay NIP-FI authority boundary is
//! compiler-enforced.  Each fixture must fail to compile; trybuild records the
//! actual rustc error as a `.stderr` snapshot.
//!
//! ## Fixtures
//!
//! - `context_sealed_from_external.rs` — external crate cannot name or
//!   construct `SealedRequestContext`; the entire `nip_fi` module is private.
//!   Tests the outer module privacy wall.
//!
//! - `authority_output_opaque.rs` — external crate cannot name the admission
//!   function `commit_admission_in_tx`; both the outer `nip_fi` module and
//!   the function itself are crate-private.  Tests the output-type boundary.
//!
//! ## Intra-relay `seal_inline` boundary
//!
//! `SealedRequestContext::seal_inline` is `pub(super)`, which restricts its
//! use to the `buzz_relay::nip_fi` module itself.  Other `buzz_relay` modules
//! (e.g., `handlers::event`) cannot call it at compile time.  Trybuild fixtures
//! always test from an external-crate perspective where the outer module
//! privacy wall fires first; the `pub(super)` contract is enforced by the
//! compiler within `buzz_relay` and is documented in `context.rs`.

#[test]
fn seal_boundary_compile_fail() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/*.rs");
}

//! Compile-fail evidence: `seal_inline` is `pub(super)` — an independent inner
//! wall enforced even when the outer `nip_fi` module visibility is dissolved.
//!
//! ## Setup
//!
//! This test links against `buzz-relay` compiled with `features =
//! ["nip-fi-boundary-test"]`, which re-exports `nip_fi` and
//! `nip_fi::context` as public modules.  With the outer wall gone, the only
//! remaining barrier is `seal_inline`'s own `pub(super)` visibility.
//!
//! ## Fixture
//!
//! `seal_inline_pub_super_wall.rs` — attempts
//! `buzz_relay::nip_fi::context::SealedRequestContext::seal_inline`.  With
//! outer walls dissolved, rustc reports E0624 (`seal_inline` is private).
//! Widening `seal_inline` to `pub(crate)` or `pub` would compile the fixture
//! (turn it green), which is the exact boundary being enforced.

#[test]
fn inner_seal_boundary_compile_fail() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/seal_inline_pub_super_wall.rs");
}

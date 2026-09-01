//! Compile-fail evidence: the relay NIP-FI authority boundary is
//! compiler-enforced.  Each fixture must fail to compile; trybuild records the
//! actual rustc error as a `.stderr` snapshot.
//!
//! ## Fixture
//!
//! - `context_sealed_from_external.rs` — proves the outer `nip_fi` module wall.
//!   The outer `mod nip_fi` is private; external crates cannot name any item
//!   inside it.  E0603 fires on any reference to `nip_fi::*`.  Widening
//!   `mod nip_fi` to `pub mod nip_fi` would remove this error (the fixture
//!   would compile or fail at an inner wall instead), proving the outer wall
//!   is load-bearing.
//!
//! ## Inner constructor wall (seal_inline and CommittedAuthorization)
//!
//! The `pub(super)` visibility on `seal_inline` and `pub(crate)` + private
//! fields on `CommittedAuthorization` are independent inner walls enforced
//! even when the outer module wall is dissolved.  Those boundaries are proven
//! by the companion crate `buzz-nip-fi-inner-seal-test`, which compiles against
//! `buzz-relay` with the `nip-fi-boundary-test` feature to dissolve the outer
//! wall, then demonstrates that `seal_inline` (E0624) and field construction
//! (E0451) still fail.  The inner-seal-test is the load-bearing boundary
//! evidence for the constructor walls.

#[test]
fn seal_boundary_compile_fail() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/context_sealed_from_external.rs");
}

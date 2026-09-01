//! Fixture: `SealedRequestContext::seal_inline` is unreachable from outside
//! the `buzz_relay::nip_fi` module.
//!
//! This fixture proves the constructor boundary for `SealedRequestContext`
//! at the `seal_inline` level.  Two distinct violations are tested:
//!
//! 1. The `buzz_relay::nip_fi` module itself is private (`mod nip_fi`), so
//!    any attempt to name items inside it from an external crate fails at the
//!    outer privacy wall.  If `nip_fi` were changed to `pub mod nip_fi`, the
//!    outer wall would dissolve.
//!
//! 2. Even if the module were public, `seal_inline` is `pub(super)` — visible
//!    only to the `buzz_relay::nip_fi` module and its immediate submodules.
//!    A `buzz_relay::handlers::*` module (or any other crate-internal caller
//!    outside `nip_fi`) cannot call it.  This `pub(super)` contract is enforced
//!    by the compiler; widening it to `pub(crate)` would allow any handler to
//!    mint a `SealedRequestContext` from arbitrary coordinates, bypassing the
//!    trusted ingest orchestrator path.
//!
//! Expected error: module `nip_fi` is private (outer wall fires first)
//! What would happen if outer wall dissolved: `seal_inline` is still `pub(super)`;
//! calling it from outside `nip_fi` would produce E0624 "method `seal_inline`
//! is private".  Widening both would allow this fixture to compile (turn green),
//! proving the combined boundary is broken.
fn main() {
    // Attempting to call seal_inline from outside nip_fi must fail.
    // Error E0603 fires on `nip_fi` (outer wall); if `nip_fi` were pub,
    // E0624 would fire on `seal_inline` (pub(super) inner wall).
    use buzz_relay::nip_fi::context::SealedRequestContext;
    let _: SealedRequestContext;
}

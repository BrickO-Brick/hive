//! Inner constructor boundary: `seal_inline` is `pub(super)`.
//!
//! This fixture is compiled against `buzz-relay` with the
//! `nip-fi-boundary-test` feature, which makes `buzz_relay::nip_fi` and
//! `buzz_relay::nip_fi::context` publicly visible.  With the outer module
//! wall dissolved, the ONLY barrier is the `pub(super)` visibility on
//! `seal_inline` itself.
//!
//! Expected error: E0624 — associated function `seal_inline` is private.
//!
//! If `seal_inline` were widened from `pub(super)` to `pub(crate)` or `pub`,
//! this fixture would compile (no error) — proving that `pub(super)` on
//! `seal_inline` is the meaningful constructor boundary, not the outer module.
fn main() {
    // nip_fi and context are pub with the nip-fi-boundary-test feature.
    // SealedRequestContext is pub(crate) normally, but with the outer module
    // now public, this path reaches the type.  The only remaining barrier is
    // seal_inline being pub(super).
    let _ = buzz_relay::nip_fi::context::SealedRequestContext::seal_inline;
}

//! Intra-boundary compile-fail tests for the NIP-FI `seal_inline` constructor.
//!
//! ## Purpose
//!
//! This crate depends on `buzz-relay` with the `nip-fi-boundary-test` feature,
//! which makes `buzz_relay::nip_fi` and `buzz_relay::nip_fi::context` publicly
//! visible (dissolving the outer module wall).  With the outer wall dissolved,
//! the compile-fail fixtures in `tests/compile_fail/` target the inner
//! constructor wall directly: `seal_inline` is `pub(super)` and fails with
//! E0624 (not E0603).
//!
//! This proves: widening the outer module wall alone is NOT sufficient to
//! expose `seal_inline`.  The `pub(super)` visibility on `seal_inline` is an
//! independent guard.  If `seal_inline` were widened to `pub(crate)` or `pub`,
//! the fixture would compile (turn green) — because that is the only remaining
//! wall when `nip_fi` and `context` are public.

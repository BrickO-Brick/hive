//! Fixture: `buzz_relay::nip_fi` is a private module — no external crate
//! can name `SealedRequestContext`, call `seal_inline`, or call `seal_context`.
//!
//! This tests the outer module privacy wall.  The relay keeps the entire `nip_fi`
//! module private so only the trusted ingest orchestrator can drive the admission
//! path.  If `nip_fi` were re-exported as `pub mod`, this fixture would compile
//! (turn green), revealing the boundary violation.
//!
//! Expected error: module `nip_fi` is private
fn main() {
    // Attempting to name the sealed context type must fail.
    let _: buzz_relay::nip_fi::context::SealedRequestContext;
}

//! Fixture: an external crate cannot access buzz_relay::nip_fi at all.
//! The module is declared as `mod nip_fi` (crate-private) in buzz-relay,
//! so no external crate can even name the path.
//!
//! Expected error: module `nip_fi` is private
fn main() {
    // buzz_relay::nip_fi is a private module — this must not compile.
    let _: buzz_relay::nip_fi::context::SealedRequestContext;
}

//! Fixture: seal_context is pub(super) inside buzz-relay::nip_fi::context,
//! invisible even within the rest of buzz-relay crate (it doesn't appear in
//! nip_fi/mod.rs re-exports).  External crates cannot call it.
//!
//! Expected error: module `nip_fi` is private
fn main() {
    // nip_fi is a private relay module — seal_context cannot be reached.
    let _ = buzz_relay::nip_fi::context::seal_context;
}

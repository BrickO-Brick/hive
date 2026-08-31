//! Fixture: the output types of the admission path are opaque to external crates.
//!
//! `CommittedAuthorization` and `AuthorizedUse` are `pub(crate)` structs with
//! no public fields and no public constructors.  Even if `commit_admission_in_tx`
//! were somehow reachable, the caller could not construct or inspect these types.
//!
//! This fixture tests the admission function boundary: even naming
//! `commit_admission_in_tx` requires entering the private `nip_fi` module.
//! If `nip_fi::admission` were re-exported as pub and `commit_admission_in_tx`
//! were made pub, this fixture would compile (turn green), revealing that the
//! authority output types need their own sealing.
//!
//! Expected error: module `nip_fi` is private
fn main() {
    // Attempting to name the admission function must fail — both the outer
    // module and the function itself are crate-private.
    let _ = buzz_relay::nip_fi::admission::commit_admission_in_tx;
}

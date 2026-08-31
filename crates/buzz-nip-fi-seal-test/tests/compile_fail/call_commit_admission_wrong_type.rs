//! Fixture: commit_admission requires a SealedRequestContext that cannot
//! be constructed by an external crate.  Even if the function were accessible,
//! there is no public path to produce its context argument.
//!
//! Expected error: module `nip_fi` is private (the whole module is crate-private)
fn main() {
    // buzz_relay::nip_fi is private — cannot reach commit_admission either.
    // The type-check never reaches the argument — the module path itself fails.
    let _ = buzz_relay::nip_fi::admission::commit_admission;
}

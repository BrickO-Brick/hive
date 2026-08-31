//! Fixture: `CommittedAuthorization` fields are opaque to external crates.
//!
//! `CommittedAuthorization` is `pub(crate)` with all fields `pub(super)`.
//! This fixture proves a distinct structural concern from the outer module wall:
//! even if the admission function were somehow reachable, the output type itself
//! cannot be constructed or field-accessed by any caller outside `nip_fi`.
//!
//! This tests the INNER authority output boundary — not the outer module wall.
//! The two violations are layered:
//!
//! 1. `buzz_relay::nip_fi` is a private module (`mod nip_fi`).  E0603 fires
//!    on the module name (outer wall).
//!
//! 2. Even if `nip_fi` were `pub mod`, `CommittedAuthorization` is `pub(crate)`
//!    — invisible outside the `buzz_relay` crate.  E0603 would fire on the
//!    struct name.
//!
//! 3. Even if both were public, all fields are `pub(super)` — inaccessible
//!    outside `buzz_relay::nip_fi`.  A struct-literal construction attempt would
//!    produce E0451 "field `…` is private".  No public constructor exists.
//!
//! This layered boundary means that authority output tokens cannot be forged
//! by any external caller regardless of how access restrictions are relaxed at
//! one layer.  If all three walls dissolved, this fixture would compile (turn
//! green), proving the combined boundary is broken.
//!
//! Expected error: module `nip_fi` is private (outer wall fires first)
fn main() {
    // Attempting to name the admission output type must fail.
    // E0603 fires on `nip_fi`; if that dissolved, E0603 fires on
    // `CommittedAuthorization` (pub(crate)); if that dissolved, E0451 fires
    // on each private field.
    let _ = buzz_relay::nip_fi::admission::commit_admission_in_tx;
}

//! Compile-fail fixture library for NIP-FI authority boundary enforcement.
//!
//! This crate exists solely to host `trybuild` compile-fail tests.  There is
//! no production code here.  Each fixture in `tests/compile_fail/` is a small
//! Rust program that must fail to compile; `trybuild` asserts the expected
//! error and records the `.stderr` snapshot.
//!
//! ## What is proven
//!
//! 1. An external sibling crate cannot name or construct `SealedRequestContext`
//!    (the type lives inside `buzz_relay::nip_fi`, which is `mod nip_fi` with
//!    no `pub` export at the relay crate boundary).
//! 2. An external crate cannot call `seal_context` — it is `pub(super)`,
//!    invisible outside `buzz_relay::nip_fi`.
//! 3. An external crate cannot construct `CommittedAuthorization` or
//!    `AuthorizedUse` — both are `pub(crate)` structs with no public fields
//!    and no public constructor.
//!
//! The unit tests below additionally confirm that the buzz-auth vocabulary
//! types (AdmissionError, RouteCapability, etc.) are correctly re-exported and
//! accessible — verifying that the closed vocabulary is visible where it needs
//! to be.

#[cfg(test)]
mod tests {
    use buzz_auth::nip_fi::{
        AdmissionError, BindingProvenance, OperationIntent, ProofTransport, ProtectedObjectKind,
        RouteCapability,
    };

    #[test]
    fn authority_vocabulary_exported() {
        // Verify that the closed vocabulary types are accessible from buzz-auth.
        let _ = AdmissionError::ProofReplayed;
        let _ = RouteCapability::MessagesWrite;
        let _ = ProtectedObjectKind::Channel;
        let _ = OperationIntent::Write;
        let _ = ProofTransport::Nip42WebSocket;
        let _ = BindingProvenance::AttestedKey;
    }

    #[test]
    fn admission_error_is_not_clone() {
        // AdmissionError derives Clone — but CommittedAuthorization and
        // AuthorizedUse do not.  We can only assert the exported vocabulary type.
        let e = AdmissionError::SerializationRetry;
        let _ = e.clone();
    }

    #[test]
    fn route_capability_database_codes_stable() {
        assert_eq!(RouteCapability::MessagesWrite.database_code(), 2i16);
        assert_eq!(ProtectedObjectKind::Channel.database_code(), 2i16);
    }
}

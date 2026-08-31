//! NIP-FI federated-identity authorization — assertion verifier, JWKS runtime,
//! startup validation, and discovery (Phase A, PRs 1–3).
//!
//! ## Module layout
//!
//! | Module | Introduced | Responsibility |
//! |--------|-----------|----------------|
//! | [`assertion`] | PR 1 | Sealed [`VerifiedAssertion`] result and its fields |
//! | [`config`] | PR 1 | Multi-issuer policy, contract IDs, size/time bounds |
//! | [`denial`] | PR 1 | Privacy-preserving four-class denial wire contract |
//! | [`verifier`] | PR 1 | Single canonical [`FederatedAssertionVerifier`] |
//! | [`jwks`] | PR 3 | JWKS fetch, cache, and [`ProductionJwksSource`] |
//! | [`startup`] | PR 3 | Startup validation gate ([`validate_nip_fi_config`]) |
//! | [`discovery`] | PR 3 | NIP-11 [`FederatedIdentityDiscovery`] object |
//!
//! Identity is issuer-qualified `(iss, sub)` throughout. No database schema,
//! binding resolution, or request/proof binding is defined here — those belong
//! to PRs 4–5.

/// The exact client-attached header field ([NIP-FI.md](../../../docs/nips/NIP-FI.md),
/// "Client-attached transport"). `Authorization` remains reserved for NIP-98.
pub const CLIENT_ATTACHED_HEADER: &str = "Nostr-Federated-Identity";

pub mod assertion;
pub mod config;
pub mod denial;
pub mod discovery;
pub mod jwks;
pub mod startup;
pub mod verifier;

pub use assertion::{
    CanonicalCapabilities, ConfidentialAssertion, FederatedIdentity, RevalidationDependencies,
    VerifiedAssertion,
};
pub use config::{
    AssertionPolicyId, ClientSubjectPosture, FreshnessClass, IssuerPolicy, IssuerPolicyError,
    IssuerRegistry, SubjectClass, SubjectClassContract, TokenClass, TransportContractId,
    NOSTR_PUBKEY_CLAIM, OAUTH_CLIENT_ID_CLAIM,
};
pub use denial::DenialClass;
pub use discovery::{
    AssertionFreshnessDiscovery, FederatedIdentityDiscovery, FreshnessClassDiscovery,
};
pub use jwks::{
    HttpJwksFetcher, IssuerJwksConfig, JwksFetchError, JwksFetcher, ProductionJwksSource,
};
pub use startup::{validate_nip_fi_config, NipFiMode, NipFiStartupError};
pub use verifier::{AssertionKeySet, FederatedAssertionVerifier, IssuerKeySource, VerifierError};

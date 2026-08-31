//! NIP-11 federated-identity discovery output (NIP-FI Phase A, PR 3).
//!
//! [`FederatedIdentityDiscovery`] serializes to the `federated_identity`
//! object NIP-FI.md "Discovery" requires in NIP-11 relay information.
//!
//! ## Privacy invariants
//!
//! The discovery object MUST NOT contain: enrollment mode, TOFU posture,
//! issuer URLs, audiences, claim names, tenant IDs, or deployment-local
//! identifiers. For a fixed set of claimed profiles the complete output is
//! byte-identical across every enrollment policy and lifecycle state.
//! [FI-TRACE-DISCOVERY-PRIVATE]
//!
//! ## Offline-jwt residual bound
//!
//! `maximum_residual_upstream_revocation_seconds` is `null` for `offline-jwt`
//! deployments. An offline-jwt deployment MUST NOT advertise a finite value
//! here (NIP-FI.md:259-266).

use serde::{Deserialize, Serialize};

/// The `assertion_freshness` sub-object inside `federated_identity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssertionFreshnessDiscovery {
    /// `"offline-jwt"` or `"current-status"`.
    pub class: FreshnessClassDiscovery,
    /// `null` for `offline-jwt`; a tested positive integer for `current-status`.
    pub maximum_residual_upstream_revocation_seconds: Option<u64>,
}

/// The freshness class as a stable wire string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FreshnessClassDiscovery {
    /// Validates the JWT and JWKS snapshot only.
    OfflineJwt,
    /// Additionally requires a current-status witness.
    CurrentStatus,
}

/// The `federated_identity` NIP-11 discovery object.
///
/// Placed under `limitation.federated_identity = true` and the top-level
/// `federated_identity` key in the NIP-11 relay information document.
/// Fields never expose enrollment mode, issuer, audience, or private state.
/// [FI-TRACE-DISCOVERY-PRIVATE]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FederatedIdentityDiscovery {
    /// Always `"client-attached"` for core.
    pub core: String,
    /// The assertion freshness contract claimed by this deployment.
    pub assertion_freshness: AssertionFreshnessDiscovery,
}

impl FederatedIdentityDiscovery {
    /// Construct an offline-jwt discovery object. This is the minimal core
    /// claim that carries no residual revocation bound.
    pub fn offline_jwt() -> Self {
        Self {
            core: "client-attached".to_owned(),
            assertion_freshness: AssertionFreshnessDiscovery {
                class: FreshnessClassDiscovery::OfflineJwt,
                maximum_residual_upstream_revocation_seconds: None,
            },
        }
    }

    /// Construct a current-status discovery object with a tested positive
    /// revocation bound (in seconds). The caller is responsible for ensuring
    /// `revocation_bound_seconds` has been empirically verified.
    ///
    /// Returns `None` when `revocation_bound_seconds` is zero.
    pub fn current_status(revocation_bound_seconds: u64) -> Option<Self> {
        if revocation_bound_seconds == 0 {
            return None;
        }
        Some(Self {
            core: "client-attached".to_owned(),
            assertion_freshness: AssertionFreshnessDiscovery {
                class: FreshnessClassDiscovery::CurrentStatus,
                maximum_residual_upstream_revocation_seconds: Some(revocation_bound_seconds),
            },
        })
    }
}

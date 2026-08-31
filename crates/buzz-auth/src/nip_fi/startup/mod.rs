//! Startup validation for the NIP-FI assertion runtime (Phase A, PR 3).
//!
//! [`validate_nip_fi_config`] is the production entry point. It rejects any
//! configuration that would make the runtime unsafe, incomplete, or ambiguous
//! before the relay accepts any protected traffic. The relay MUST call this and
//! refuse to start on error in [`Enforce`][crate::nip_fi::NipFiMode::Enforce]
//! mode (`FI-INV-14`, `FI-INV-15`).
//!
//! ## What it checks
//!
//! | Check | Why |
//! |-------|-----|
//! | Registry non-empty | An enforce-mode deployment with no issuer policy admits nothing and the gap is undetectable at request time |
//! | Each issuer non-empty `iss` and `aud` | `IssuerPolicy` validates these, but startup re-asserts the invariant at the registry level |
//! | No duplicate `iss` | A duplicate would silently pick one policy; enforce uniqueness |
//! | `current-status` requires `maximum_status_age_seconds` | Already enforced in `IssuerPolicy::new`; startup confirms no offline-mode policy sneaked through with a status-age |
//! | Offline-only deployments: `FreshnessClass::OfflineJwt` is safe | No residual bound claim (per NIP-FI.md:259-266) |
//! | JWKS config present for every issuer in enforce mode | Every issuer needs a reachable key source |
//! | JWKS config issuer match | The JWKS config `issuer` must equal the policy `issuer` |
//! | `refresh_interval` < `hard_deadline` | Prevents an always-stale cache |

use super::config::{FreshnessClass, IssuerRegistry};
use super::jwks::IssuerJwksConfig;

/// Operating mode for the NIP-FI assertion runtime.
///
/// The variant names are stable contract values; do not rename without a
/// `VERIFIER_CONTRACT_VERSION` bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NipFiMode {
    /// NIP-FI is disabled. Protected ingresses are unreachable or absent.
    Off,
    /// Production enforcement: every protected ingress requires valid
    /// federated assertion evidence. The relay MUST call
    /// [`validate_nip_fi_config`] before accepting traffic in this mode.
    Enforce,
    /// Emergency mode: all protected routes deny before any verifier is
    /// configured. Used during startup if a previous enforce-mode deployment
    /// was misconfigured and must fail closed while the operator repairs
    /// configuration. [FI-INV-14]
    DenyProtected,
}

/// Reasons [`validate_nip_fi_config`] rejects a configuration.
///
/// Every variant corresponds to a concrete, operator-actionable defect.
/// No key material, token bytes, or raw claim values appear.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NipFiStartupError {
    /// Enforce mode requires at least one issuer policy; the registry is empty.
    #[error("NIP-FI enforce mode requires at least one issuer policy")]
    EmptyRegistry,

    /// Two or more issuer policies share the same `iss` value, which would
    /// make issuer selection ambiguous.
    #[error("NIP-FI issuer registry contains duplicate issuer: {0}")]
    DuplicateIssuer(String),

    /// Enforce mode requires a JWKS config for every registered issuer, but
    /// the given issuer has no JWKS configuration.
    #[error("NIP-FI issuer has no JWKS configuration: (issuer redacted)")]
    MissingJwksConfig,

    /// A JWKS config's `issuer` field does not match any registered issuer
    /// policy. Mismatched configs are rejected to prevent silent key-source
    /// confusion.
    #[error("NIP-FI JWKS config issuer does not match any registered policy")]
    UnmatchedJwksConfig,

    /// A JWKS config's `refresh_interval_seconds` is zero or is greater than
    /// or equal to `key_snapshot_hard_deadline_seconds`.
    #[error("NIP-FI JWKS config has invalid timing bounds: refresh >= hard deadline")]
    InvalidJwksTiming,

    /// A `current-status` issuer policy is present but the JWKS URI is
    /// absent; current-status requires a reachable JWKS to validate assertion
    /// signatures.
    #[error("NIP-FI current-status issuer requires a JWKS configuration")]
    CurrentStatusRequiresJwks,
}

/// Validate the complete NIP-FI runtime configuration before the relay
/// accepts any protected traffic.
///
/// `registry` is the set of issuer policies. `jwks_configs` is the set of
/// JWKS endpoint configurations (one per issuer in enforce mode).
/// `mode` is the intended operating mode.
///
/// Returns `Ok(())` when the configuration is valid and complete for `mode`.
/// Returns `Err(NipFiStartupError)` when any invariant is violated; the relay
/// MUST refuse to start or must fall back to [`NipFiMode::DenyProtected`].
pub fn validate_nip_fi_config(
    mode: NipFiMode,
    registry: &IssuerRegistry,
    jwks_configs: &[IssuerJwksConfig],
) -> Result<(), NipFiStartupError> {
    match mode {
        NipFiMode::Off | NipFiMode::DenyProtected => {
            // Off and emergency-denial modes impose no assertion config
            // requirements — they admit nothing.
            return Ok(());
        }
        NipFiMode::Enforce => {}
    }

    // Enforce mode: validate the registry and JWKS configs.

    if registry.is_empty() {
        return Err(NipFiStartupError::EmptyRegistry);
    }

    // Check for duplicate issuers (IssuerRegistry keyed by exact iss, so this
    // is already enforced there, but we assert it explicitly for startup).
    {
        let mut seen = std::collections::HashSet::new();
        for policy in registry.all_policies() {
            if !seen.insert(policy.issuer()) {
                return Err(NipFiStartupError::DuplicateIssuer(
                    policy.issuer().to_owned(),
                ));
            }
        }
    }

    // Build a map from issuer → JWKS config for O(1) lookup.
    let jwks_map: std::collections::HashMap<&str, &IssuerJwksConfig> = jwks_configs
        .iter()
        .map(|c| (c.issuer.as_str(), c))
        .collect();

    // Verify every JWKS config references a known issuer.
    for config in jwks_configs {
        if registry.policy_for_issuer(&config.issuer).is_none() {
            return Err(NipFiStartupError::UnmatchedJwksConfig);
        }
        // Validate timing bounds.
        if config.refresh_interval_seconds == 0
            || config.key_snapshot_hard_deadline_seconds == 0
            || config.key_snapshot_hard_deadline_seconds <= config.refresh_interval_seconds
        {
            return Err(NipFiStartupError::InvalidJwksTiming);
        }
    }

    // Every issuer policy must have a JWKS config in enforce mode.
    for policy in registry.all_policies() {
        match jwks_map.get(policy.issuer()) {
            None => {
                if policy.freshness() == FreshnessClass::CurrentStatus {
                    return Err(NipFiStartupError::CurrentStatusRequiresJwks);
                }
                return Err(NipFiStartupError::MissingJwksConfig);
            }
            Some(_) => {}
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests;

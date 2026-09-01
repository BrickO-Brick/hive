//! Durable Mantap identity binding and first-login provisioning.

use buzz_core::CommunityId;
use buzz_datastore_tracing::datastore_span;
use chrono::{DateTime, Utc};
use sqlx::Row as _;
use uuid::Uuid;

use crate::error::{DbError, Result};
use crate::Db;

/// Result of consuming one Mantap SSO ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MantapSsoProvisionOutcome {
    /// The identity was provisioned or refreshed successfully.
    Provisioned {
        /// Whether this exchange created the relay-level member row.
        relay_member_inserted: bool,
    },
    /// This exact short-lived ticket was already consumed.
    Replayed,
    /// The Nostr key is already bound to another Mantap subject.
    PubkeyConflict,
}

/// Input validated by the relay before database provisioning.
pub struct MantapSsoProvision<'a> {
    /// Community resolved from the request authority.
    pub community_id: CommunityId,
    /// Default Hive channel granted on first login.
    pub channel_id: Uuid,
    /// Stable authoritative Mantap user subject.
    pub subject: &'a str,
    /// Normalized Mantap email address.
    pub email: &'a str,
    /// Mantap access claim retained for audit context.
    pub access: &'a str,
    /// One-time JWT identifier.
    pub jti: &'a str,
    /// Ticket expiry retained for replay-store maintenance.
    pub expires_at: DateTime<Utc>,
    /// Raw 32-byte Nostr public key.
    pub pubkey: &'a [u8],
    /// Lowercase hexadecimal representation of `pubkey`.
    pub pubkey_hex: &'a str,
}

/// Atomically consume a ticket, bind the identity, and add ordinary relay and
/// channel membership. Existing elevated roles are never changed.
pub async fn provision_mantap_sso(
    db: &Db,
    input: MantapSsoProvision<'_>,
) -> Result<MantapSsoProvisionOutcome> {
    if input.pubkey.len() != 32 {
        return Err(DbError::InvalidData("pubkey must be 32 bytes".into()));
    }
    let mut tx = db.pool.begin().await?;

    let ticket_inserted = sqlx::query(
        "INSERT INTO mantap_sso_ticket_uses (community_id, jti, subject, expires_at) \
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    )
    .bind(input.community_id.as_uuid())
    .bind(input.jti)
    .bind(input.subject)
    .bind(input.expires_at)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if !ticket_inserted {
        return Ok(MantapSsoProvisionOutcome::Replayed);
    }

    let pubkey_binding = sqlx::query(
        "SELECT subject FROM mantap_sso_bindings WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(input.community_id.as_uuid())
    .bind(input.pubkey)
    .fetch_optional(&mut *tx)
    .await?;
    if pubkey_binding
        .as_ref()
        .is_some_and(|row| row.get::<String, _>("subject") != input.subject)
    {
        return Ok(MantapSsoProvisionOutcome::PubkeyConflict);
    }

    sqlx::query(
        "INSERT INTO mantap_sso_bindings \
         (community_id, subject, email, pubkey, access) VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (community_id, subject, pubkey) DO UPDATE SET \
         email = EXCLUDED.email, access = EXCLUDED.access, last_verified_at = transaction_timestamp()",
    )
    .bind(input.community_id.as_uuid())
    .bind(input.subject)
    .bind(input.email)
    .bind(input.pubkey)
    .bind(input.access)
    .execute(&mut *tx)
    .await?;

    let display_name = input.email.split('@').next().unwrap_or(input.email);
    sqlx::query(
        "INSERT INTO users (community_id, pubkey, nip05_handle, display_name) \
         VALUES ($1, $2, $3, $4) ON CONFLICT (community_id, pubkey) DO UPDATE SET \
         nip05_handle = EXCLUDED.nip05_handle, \
         display_name = COALESCE(users.display_name, EXCLUDED.display_name), \
         updated_at = transaction_timestamp()",
    )
    .bind(input.community_id.as_uuid())
    .bind(input.pubkey)
    .bind(input.email)
    .bind(display_name)
    .execute(&mut *tx)
    .await?;

    let relay_member_inserted = sqlx::query(
        "INSERT INTO relay_members (community_id, pubkey, role, added_by) \
         VALUES ($1, $2, 'member', 'mantap-sso') ON CONFLICT DO NOTHING",
    )
    .bind(input.community_id.as_uuid())
    .bind(input.pubkey_hex)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;

    sqlx::query(
        "INSERT INTO channel_members (community_id, channel_id, pubkey, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET \
         removed_at = NULL, removed_by = NULL, hidden_at = NULL",
    )
    .bind(input.community_id.as_uuid())
    .bind(input.channel_id)
    .bind(input.pubkey)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(MantapSsoProvisionOutcome::Provisioned {
        relay_member_inserted,
    })
}

impl Db {
    /// Consume a verified Mantap ticket and provision its bound Hive identity.
    #[datastore_span(name = "provision_mantap_sso", system = "postgresql")]
    pub async fn provision_mantap_sso(
        &self,
        input: MantapSsoProvision<'_>,
    ) -> Result<MantapSsoProvisionOutcome> {
        provision_mantap_sso(self, input).await
    }
}

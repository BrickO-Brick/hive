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
        /// Whether this exchange inserted or changed any relay membership role.
        relay_membership_changed: bool,
        /// Effective Hive role derived from the authoritative Mantap access claim.
        role: MantapSsoRole,
    },
    /// This exact short-lived ticket was already consumed.
    Replayed,
    /// The Nostr key is already bound to another Mantap subject.
    PubkeyConflict,
}

/// Hive workspace role derived from Mantap's signed access claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MantapSsoRole {
    /// Mantap read/write access maps to full Hive workspace ownership.
    Owner,
    /// Mantap read-only access maps to an ordinary Hive member.
    Member,
}

impl MantapSsoRole {
    /// Resolve the exact access vocabulary accepted from Mantap.
    pub fn from_access(access: &str) -> Option<Self> {
        match access {
            "editor" | "admin" => Some(Self::Owner),
            "reader" => Some(Self::Member),
            _ => None,
        }
    }

    /// Return the relay-membership representation stored by Hive.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Member => "member",
        }
    }
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

/// Atomically consume a ticket, bind the identity, and synchronize Mantap's
/// authoritative access level into relay membership. Channel membership stays
/// ordinary because channel-specific ownership is managed separately.
pub async fn provision_mantap_sso(
    db: &Db,
    input: MantapSsoProvision<'_>,
) -> Result<MantapSsoProvisionOutcome> {
    if input.pubkey.len() != 32 {
        return Err(DbError::InvalidData("pubkey must be 32 bytes".into()));
    }
    let role = MantapSsoRole::from_access(input.access)
        .ok_or_else(|| DbError::InvalidData("unsupported Mantap access claim".into()))?;
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
         VALUES ($1, $2, $3, 'mantap-sso') ON CONFLICT DO NOTHING",
    )
    .bind(input.community_id.as_uuid())
    .bind(input.pubkey_hex)
    .bind(role.as_str())
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;

    let current_role_changed = if relay_member_inserted {
        false
    } else {
        sqlx::query(
            "UPDATE relay_members SET role = $3, updated_at = transaction_timestamp() \
             WHERE community_id = $1 AND pubkey = $2 AND role IS DISTINCT FROM $3",
        )
        .bind(input.community_id.as_uuid())
        .bind(input.pubkey_hex)
        .bind(role.as_str())
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1
    };

    // Mantap access is subject-scoped, while Hive may bind one subject to
    // several browser keys. Synchronize every bound key so a demoted subject
    // cannot retain owner access through a device that has not logged in again.
    let sibling_roles_changed = sqlx::query(
        "UPDATE relay_members AS rm SET role = $3, updated_at = transaction_timestamp() \
         FROM mantap_sso_bindings AS binding \
         WHERE binding.community_id = $1 AND binding.subject = $2 \
           AND rm.community_id = binding.community_id \
           AND rm.pubkey = encode(binding.pubkey, 'hex') \
           AND rm.role IS DISTINCT FROM $3",
    )
    .bind(input.community_id.as_uuid())
    .bind(input.subject)
    .bind(role.as_str())
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;

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
        relay_membership_changed: relay_member_inserted
            || current_role_changed
            || sibling_roles_changed,
        role,
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use sqlx::PgPool;

    #[test]
    fn maps_mantap_rbac_to_hive_roles() {
        assert_eq!(
            MantapSsoRole::from_access("reader"),
            Some(MantapSsoRole::Member)
        );
        assert_eq!(
            MantapSsoRole::from_access("editor"),
            Some(MantapSsoRole::Owner)
        );
        assert_eq!(
            MantapSsoRole::from_access("admin"),
            Some(MantapSsoRole::Owner)
        );
        assert_eq!(MantapSsoRole::from_access("write"), None);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn provisioning_synchronizes_subject_roles_across_bound_keys() {
        const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned());
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to test database");
        let db = Db::from_pool(pool.clone());
        let community_uuid = Uuid::new_v4();
        let community = CommunityId::from_uuid(community_uuid);
        let channel_id = Uuid::new_v4();
        let creator = [9_u8; 32];
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(format!("mantap-rbac-{}.example", community_uuid.simple()))
            .execute(&pool)
            .await
            .expect("insert test community");
        sqlx::query(
            "INSERT INTO channels (community_id, id, name, created_by) VALUES ($1, $2, $3, $4)",
        )
        .bind(community_uuid)
        .bind(channel_id)
        .bind("mantap-rbac")
        .bind(creator.as_slice())
        .execute(&pool)
        .await
        .expect("insert test channel");

        let first_key = [1_u8; 32];
        let first_hex = "01".repeat(32);
        let first = provision_mantap_sso(
            &db,
            MantapSsoProvision {
                community_id: community,
                channel_id,
                subject: "mantul-user:rbac-test",
                email: "owner@onebrick.io",
                access: "editor",
                jti: "rbac-editor-first",
                expires_at: Utc::now() + Duration::minutes(1),
                pubkey: &first_key,
                pubkey_hex: &first_hex,
            },
        )
        .await
        .expect("provision editor");
        assert_eq!(
            first,
            MantapSsoProvisionOutcome::Provisioned {
                relay_member_inserted: true,
                relay_membership_changed: true,
                role: MantapSsoRole::Owner,
            }
        );

        let second_key = [2_u8; 32];
        let second_hex = "02".repeat(32);
        provision_mantap_sso(
            &db,
            MantapSsoProvision {
                community_id: community,
                channel_id,
                subject: "mantul-user:rbac-test",
                email: "owner@onebrick.io",
                access: "reader",
                jti: "rbac-reader-second",
                expires_at: Utc::now() + Duration::minutes(1),
                pubkey: &second_key,
                pubkey_hex: &second_hex,
            },
        )
        .await
        .expect("provision reader on second key");

        let roles: Vec<(String, String)> = sqlx::query_as(
            "SELECT pubkey, role FROM relay_members WHERE community_id = $1 AND pubkey = ANY($2) ORDER BY pubkey",
        )
        .bind(community_uuid)
        .bind(vec![first_hex, second_hex])
        .fetch_all(&pool)
        .await
        .expect("read synchronized roles");
        assert_eq!(
            roles,
            vec![
                ("01".repeat(32), "member".to_owned()),
                ("02".repeat(32), "member".to_owned()),
            ]
        );
    }
}

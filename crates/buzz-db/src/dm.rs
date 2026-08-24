//! Direct message channel persistence.
//!
//! DMs are channels with channel_type='dm' and visibility='private'.
//! Participant sets are immutable -- adding a member creates a NEW DM.

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::channel::ChannelRecord;
use crate::error::{DbError, Result};
use buzz_core::CommunityId;

// -- Public structs -----------------------------------------------------------

/// A DM conversation with its participant list.
#[derive(Debug, Clone)]
pub struct DmRecord {
    /// The underlying channel ID.
    pub channel_id: Uuid,
    /// All active participants in this DM.
    pub participants: Vec<DmParticipant>,
    /// When the last message was sent (approximated by channel updated_at).
    pub last_message_at: Option<DateTime<Utc>>,
    /// When the DM was created.
    pub created_at: DateTime<Utc>,
}

/// A single participant in a DM.
#[derive(Debug, Clone)]
pub struct DmParticipant {
    /// Compressed public key bytes.
    pub pubkey: Vec<u8>,
    /// Optional display name from the users table.
    pub display_name: Option<String>,
    /// Member role string (always "member" for DMs).
    pub role: String,
}

// -- Pure helpers -------------------------------------------------------------

/// Compute a stable SHA-256 fingerprint for a set of participant pubkeys.
///
/// Pubkeys are sorted lexicographically before hashing so that the same set
/// of participants always produces the same hash regardless of input order.
/// No separator is used because all pubkeys are fixed-width 32-byte values.
pub fn compute_participant_hash(pubkeys: &[&[u8]]) -> [u8; 32] {
    let mut sorted: Vec<&[u8]> = pubkeys.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    let mut hasher = Sha256::new();
    for pk in sorted {
        hasher.update(pk);
    }
    hasher.finalize().into()
}

// -- DB functions -------------------------------------------------------------

/// Find an existing DM by its participant hash.
///
/// Returns `None` if no matching DM exists or if it has been deleted.
pub async fn find_dm_by_participants(
    pool: &PgPool,
    community_id: CommunityId,
    participant_hash: &[u8],
) -> Result<Option<ChannelRecord>> {
    let row = sqlx::query(
        r#"
        SELECT id, name, channel_type::text AS channel_type, visibility::text AS visibility,
               description, canvas,
               created_by, created_at, updated_at, archived_at, deleted_at,
               nip29_group_id, topic_required, max_members,
               topic, topic_set_by, topic_set_at,
               purpose, purpose_set_by, purpose_set_at
        FROM channels
        WHERE community_id = $1
          AND participant_hash = $2
          AND channel_type = 'dm'
          AND deleted_at IS NULL
        LIMIT 1
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(participant_hash)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_channel_record).transpose()
}

/// Create a new DM channel for the given participant pubkeys, or return the
/// existing one if a DM with the same participant set already exists.
///
/// Rules:
/// - `participants` must contain 2-9 entries (enforced here).
/// - `created_by` must be one of the participants.
/// - The operation is idempotent: same participant set -> same channel returned.
pub async fn create_dm(
    pool: &PgPool,
    community_id: CommunityId,
    participants: &[&[u8]],
    created_by: &[u8],
) -> Result<ChannelRecord> {
    if participants.len() < 2 {
        return Err(DbError::InvalidData(
            "DM requires at least 2 participants".to_string(),
        ));
    }
    if participants.len() > 9 {
        return Err(DbError::InvalidData(
            "DM supports at most 9 participants".to_string(),
        ));
    }
    for pk in participants {
        if pk.len() != 32 {
            return Err(DbError::InvalidData(format!(
                "pubkey must be 32 bytes, got {}",
                pk.len()
            )));
        }
    }

    let hash = compute_participant_hash(participants);

    let mut tx = pool.begin().await?;

    // Idempotency check inside the transaction.
    let existing = sqlx::query(
        r#"
        SELECT id, name, channel_type::text AS channel_type, visibility::text AS visibility,
               description, canvas,
               created_by, created_at, updated_at, archived_at, deleted_at,
               nip29_group_id, topic_required, max_members,
               topic, topic_set_by, topic_set_at,
               purpose, purpose_set_by, purpose_set_at
        FROM channels
        WHERE community_id = $1
          AND participant_hash = $2
          AND channel_type = 'dm'
          AND deleted_at IS NULL
        LIMIT 1
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(hash.as_slice())
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(row) = existing {
        tx.commit().await?;
        return row_to_channel_record(row);
    }

    // Name the DM based on participant count.
    let name = if participants.len() == 2 {
        "DM".to_string()
    } else {
        format!("Group DM ({})", participants.len())
    };

    let id = Uuid::new_v4();

    sqlx::query(
        r#"
        INSERT INTO channels
            (id, community_id, name, channel_type, visibility, created_by, participant_hash)
        VALUES ($1, $2, $3, 'dm', 'private', $4, $5)
        "#,
    )
    .bind(id)
    .bind(community_id.as_uuid())
    .bind(&name)
    .bind(created_by)
    .bind(hash.as_slice())
    .execute(&mut *tx)
    .await?;

    // Add all participants as members with role='member'.
    for pk in participants {
        sqlx::query(
            r#"
            INSERT INTO channel_members (community_id, channel_id, pubkey, role, invited_by)
            VALUES ($1, $2, $3, 'member', $4)
            ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
                removed_at = NULL,
                removed_by = NULL,
                role = EXCLUDED.role
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(id)
        .bind(*pk)
        .bind(created_by)
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query(
        r#"
        SELECT id, name, channel_type::text AS channel_type, visibility::text AS visibility,
               description, canvas,
               created_by, created_at, updated_at, archived_at, deleted_at,
               nip29_group_id, topic_required, max_members,
               topic, topic_set_by, topic_set_at,
               purpose, purpose_set_by, purpose_set_at
        FROM channels WHERE community_id = $1 AND id = $2
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    let record = row_to_channel_record(row)?;
    tx.commit().await?;
    Ok(record)
}

/// List all DM conversations for a given user, ordered by most recent activity.
///
/// Includes participant details for each DM. Supports cursor-based pagination
/// using `updated_at` ordering.
pub async fn list_dms_for_user(
    pool: &PgPool,
    community_id: CommunityId,
    pubkey: &[u8],
    limit: u32,
    cursor: Option<Uuid>,
) -> Result<Vec<DmRecord>> {
    let limit = limit.min(200) as i64;

    // Resolve cursor to a timestamp for keyset pagination.
    let cursor_ts: Option<DateTime<Utc>> = if let Some(cid) = cursor {
        let row =
            sqlx::query("SELECT updated_at FROM channels WHERE community_id = $1 AND id = $2")
                .bind(community_id.as_uuid())
                .bind(cid)
                .fetch_optional(pool)
                .await?;
        row.map(|r| r.try_get::<DateTime<Utc>, _>("updated_at"))
            .transpose()?
    } else {
        None
    };

    // Fetch DM channel IDs where this user is an active member.
    let channel_rows = if let Some(ts) = cursor_ts {
        sqlx::query(
            r#"
            SELECT c.id, c.created_at, c.updated_at
            FROM channels c
            JOIN channel_members cm
                ON c.community_id = cm.community_id
               AND c.id = cm.channel_id
               AND cm.pubkey = $2
               AND cm.removed_at IS NULL
               AND cm.hidden_at IS NULL
            WHERE c.community_id = $1
              AND c.channel_type = 'dm'
              AND c.deleted_at IS NULL
              AND c.updated_at < $3
            ORDER BY c.updated_at DESC
            LIMIT $4
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(pubkey)
        .bind(ts)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT c.id, c.created_at, c.updated_at
            FROM channels c
            JOIN channel_members cm
                ON c.community_id = cm.community_id
               AND c.id = cm.channel_id
               AND cm.pubkey = $2
               AND cm.removed_at IS NULL
               AND cm.hidden_at IS NULL
            WHERE c.community_id = $1
              AND c.channel_type = 'dm'
              AND c.deleted_at IS NULL
            ORDER BY c.updated_at DESC
            LIMIT $3
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(pubkey)
        .bind(limit)
        .fetch_all(pool)
        .await?
    };

    let mut results = Vec::with_capacity(channel_rows.len());

    for row in channel_rows {
        let channel_id: Uuid = row.try_get("id")?;
        let created_at: DateTime<Utc> = row.try_get("created_at")?;
        let updated_at: DateTime<Utc> = row.try_get("updated_at")?;

        // Fetch participants for this DM.
        let member_rows = sqlx::query(
            r#"
            SELECT cm.pubkey, cm.role::text AS role, u.display_name
            FROM channel_members cm
            LEFT JOIN users u
              ON u.community_id = cm.community_id
             AND u.pubkey = cm.pubkey
            WHERE cm.community_id = $1
              AND cm.channel_id = $2
              AND cm.removed_at IS NULL
            ORDER BY cm.joined_at ASC
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(channel_id)
        .fetch_all(pool)
        .await?;

        let participants: Vec<DmParticipant> = member_rows
            .into_iter()
            .map(|r| -> Result<DmParticipant> {
                Ok(DmParticipant {
                    pubkey: r.try_get("pubkey")?,
                    display_name: r.try_get("display_name")?,
                    role: r.try_get("role")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        results.push(DmRecord {
            channel_id,
            participants,
            last_message_at: Some(updated_at),
            created_at,
        });
    }

    Ok(results)
}

/// Open or retrieve a DM for the given set of participants.
///
/// `created_by` is automatically added to `pubkeys` if not already present,
/// ensuring the caller is always a participant in their own DM.
///
/// Returns `(channel, was_created)`:
/// - `was_created = true`  -- a new DM was created.
/// - `was_created = false` -- an existing DM was returned.
pub async fn open_dm(
    pool: &PgPool,
    community_id: CommunityId,
    pubkeys: &[&[u8]],
    created_by: &[u8],
) -> Result<(ChannelRecord, bool)> {
    // Merge created_by into the participant set (dedup handled by compute_participant_hash).
    let mut all: Vec<&[u8]> = pubkeys.to_vec();
    if !all.contains(&created_by) {
        all.push(created_by);
    }

    // Enforce max before hitting the DB.
    if all.len() > 9 {
        return Err(DbError::InvalidData(
            "DM supports at most 9 participants".to_string(),
        ));
    }

    let hash = compute_participant_hash(&all);

    // Check for existing DM first (fast path, no transaction).
    if let Some(existing) = find_dm_by_participants(pool, community_id, &hash).await? {
        // Clear hidden_at for the caller so the DM reappears in their sidebar.
        unhide_dm(pool, community_id, existing.id, created_by).await?;
        return Ok((existing, false));
    }

    // Create new DM.
    let channel = create_dm(pool, community_id, &all, created_by).await?;

    Ok((channel, true))
}

// -- Hide / unhide ------------------------------------------------------------

/// Hide a DM for a specific user by setting `hidden_at = NOW()`.
///
/// The DM is not deleted — it can be restored by opening a new DM with the
/// same participants (which clears `hidden_at`). Returns an error if the user
/// is not an active member of the channel.
pub async fn hide_dm(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
) -> Result<()> {
    let result = sqlx::query(
        r#"
        UPDATE channel_members
        SET hidden_at = NOW()
        WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 AND removed_at IS NULL
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(DbError::NotFound(format!(
            "no active membership for channel {channel_id}"
        )));
    }

    Ok(())
}

/// Unhide a DM for a specific user by clearing `hidden_at`.
///
/// This is called automatically when a user re-opens a DM via [`open_dm`].
/// It is a no-op if the membership is not currently hidden.
pub async fn unhide_dm(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE channel_members
        SET hidden_at = NULL
        WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 AND removed_at IS NULL
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .execute(pool)
    .await?;

    Ok(())
}

/// Clear the hidden state for every active recipient of a DM message.
///
/// The sender is deliberately excluded so sending from another surface does
/// not rewrite their sidebar preference. Returns only viewers whose hidden
/// state changed, allowing the relay to publish targeted visibility snapshots.
///
/// `message_received_at` is the relay-assigned receive time of the triggering
/// message (`events.received_at`). Only hides that are causally *older* than
/// the message are cleared: a recipient who re-hides the DM on another device
/// after the message was accepted keeps their newer choice. Both `hidden_at`
/// and `received_at` are set from the server clock (`NOW()`), so the comparison
/// is against a single monotonic authority. Because the fence is by receive
/// time (not identity), the update is idempotent — replaying the same message
/// clears the same set and never a newer hide.
pub async fn unhide_dm_recipients(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    sender_pubkey: &[u8],
    message_received_at: DateTime<Utc>,
) -> Result<Vec<Vec<u8>>> {
    let rows = sqlx::query(
        r#"
        UPDATE channel_members cm
        SET hidden_at = NULL
        FROM channels c
        WHERE cm.community_id = $1
          AND cm.channel_id = $2
          AND cm.pubkey != $3
          AND cm.removed_at IS NULL
          AND cm.hidden_at IS NOT NULL
          AND cm.hidden_at < $4
          AND c.community_id = cm.community_id
          AND c.id = cm.channel_id
          AND c.channel_type = 'dm'
          AND c.deleted_at IS NULL
        RETURNING cm.pubkey
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(sender_pubkey)
    .bind(message_received_at)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|row| row.try_get::<Vec<u8>, _>("pubkey").map_err(Into::into))
        .collect()
}

/// Return the channel IDs of all DMs the given user currently has hidden
/// (`hidden_at IS NOT NULL`) while still being an active member. Used to build
/// the relay-signed NIP-DV visibility snapshot.
pub async fn list_hidden_dms(
    pool: &PgPool,
    community_id: CommunityId,
    pubkey: &[u8],
) -> Result<Vec<Uuid>> {
    let rows = sqlx::query(
        r#"
        SELECT cm.channel_id
        FROM channel_members cm
        JOIN channels c
          ON c.community_id = cm.community_id
         AND c.id = cm.channel_id
        WHERE cm.community_id = $1
          AND cm.pubkey = $2
          AND cm.removed_at IS NULL
          AND cm.hidden_at IS NOT NULL
          AND c.channel_type = 'dm'
          AND c.deleted_at IS NULL
        ORDER BY cm.channel_id
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(pubkey)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|r| r.try_get::<Uuid, _>("channel_id").map_err(Into::into))
        .collect()
}

// -- Row mapping --------------------------------------------------------------

fn row_to_channel_record(row: sqlx::postgres::PgRow) -> Result<ChannelRecord> {
    let id: Uuid = row.try_get("id")?;
    let topic_required: bool = row.try_get("topic_required")?;

    Ok(ChannelRecord {
        id,
        name: row.try_get("name")?,
        channel_type: row.try_get("channel_type")?,
        visibility: row.try_get("visibility")?,
        description: row.try_get("description")?,
        canvas: row.try_get("canvas")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        archived_at: row.try_get("archived_at")?,
        deleted_at: row.try_get("deleted_at")?,
        nip29_group_id: row.try_get("nip29_group_id")?,
        topic_required,
        max_members: row.try_get("max_members")?,
        topic: row.try_get("topic").unwrap_or(None),
        topic_set_by: row.try_get("topic_set_by").unwrap_or(None),
        topic_set_at: row.try_get("topic_set_at").unwrap_or(None),
        purpose: row.try_get("purpose").unwrap_or(None),
        purpose_set_by: row.try_get("purpose_set_by").unwrap_or(None),
        purpose_set_at: row.try_get("purpose_set_at").unwrap_or(None),
        ttl_seconds: row.try_get("ttl_seconds").unwrap_or(None),
        ttl_deadline: row.try_get("ttl_deadline").unwrap_or(None),
    })
}

// -- Tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn participant_hash_is_order_independent() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let h1 = compute_participant_hash(&[&a, &b]);
        let h2 = compute_participant_hash(&[&b, &a]);
        assert_eq!(h1, h2, "hash must be the same regardless of input order");
    }

    #[test]
    fn participant_hash_deduplicates() {
        let a = [1u8; 32];
        let h1 = compute_participant_hash(&[&a, &a]);
        let h2 = compute_participant_hash(&[&a]);
        assert_eq!(h1, h2, "duplicate pubkeys should be deduped before hashing");
    }

    #[test]
    fn participant_hash_differs_for_different_sets() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];
        let h_ab = compute_participant_hash(&[&a, &b]);
        let h_ac = compute_participant_hash(&[&a, &c]);
        assert_ne!(h_ab, h_ac);
    }

    #[test]
    fn participant_hash_returns_32_bytes() {
        let a = [0u8; 32];
        let b = [255u8; 32];
        let h = compute_participant_hash(&[&a, &b]);
        assert_eq!(h.len(), 32);
    }

    // -- Postgres-backed fence tests ------------------------------------------
    //
    // `unhide_dm_recipients` must only clear hides that are causally older than
    // the triggering message (Jude review #1). These verify the receive-time
    // fence directly against real timestamps.

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";

    async fn setup_pool() -> PgPool {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned());

        PgPool::connect(&database_url)
            .await
            .expect("connect to test DB")
    }

    async fn make_test_community(pool: &PgPool) -> CommunityId {
        let id = Uuid::new_v4();
        let host = format!("dm-test-{}.example", id.simple());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(host)
            .execute(pool)
            .await
            .expect("insert test community");
        CommunityId::from_uuid(id)
    }

    /// Force a recipient's `hidden_at` to an explicit timestamp so the fence can
    /// be exercised deterministically without racing the wall clock.
    async fn set_hidden_at(
        pool: &PgPool,
        community_id: CommunityId,
        channel_id: Uuid,
        pubkey: &[u8],
        hidden_at: DateTime<Utc>,
    ) {
        sqlx::query(
            "UPDATE channel_members SET hidden_at = $4 \
             WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3",
        )
        .bind(community_id.as_uuid())
        .bind(channel_id)
        .bind(pubkey)
        .bind(hidden_at)
        .execute(pool)
        .await
        .expect("set hidden_at");
    }

    async fn current_hidden_at(
        pool: &PgPool,
        community_id: CommunityId,
        channel_id: Uuid,
        pubkey: &[u8],
    ) -> Option<DateTime<Utc>> {
        sqlx::query(
            "SELECT hidden_at FROM channel_members \
             WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3",
        )
        .bind(community_id.as_uuid())
        .bind(channel_id)
        .bind(pubkey)
        .fetch_one(pool)
        .await
        .expect("read hidden_at")
        .try_get::<Option<DateTime<Utc>>, _>("hidden_at")
        .expect("hidden_at column")
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn unhide_recipients_clears_hides_older_than_the_message() {
        let pool = setup_pool().await;
        let community_id = make_test_community(&pool).await;
        let sender = [1u8; 32];
        let recipient = [2u8; 32];
        let dm = create_dm(&pool, community_id, &[&sender, &recipient], &sender)
            .await
            .expect("create dm");

        // Recipient hid the DM before the message was received.
        let hidden_at = Utc::now();
        set_hidden_at(&pool, community_id, dm.id, &recipient, hidden_at).await;
        let message_received_at = hidden_at + chrono::Duration::seconds(1);

        let cleared =
            unhide_dm_recipients(&pool, community_id, dm.id, &sender, message_received_at)
                .await
                .expect("unhide");

        assert_eq!(
            cleared,
            vec![recipient.to_vec()],
            "recipient must resurface"
        );
        assert!(
            current_hidden_at(&pool, community_id, dm.id, &recipient)
                .await
                .is_none(),
            "older hide must be cleared"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn unhide_recipients_preserves_a_hide_newer_than_the_message() {
        let pool = setup_pool().await;
        let community_id = make_test_community(&pool).await;
        let sender = [3u8; 32];
        let recipient = [4u8; 32];
        let dm = create_dm(&pool, community_id, &[&sender, &recipient], &sender)
            .await
            .expect("create dm");

        // Recipient re-hid the DM on another device AFTER the message arrived
        // (e.g. a delayed replay of that message races the newer user action).
        let message_received_at = Utc::now();
        let hidden_at = message_received_at + chrono::Duration::seconds(1);
        set_hidden_at(&pool, community_id, dm.id, &recipient, hidden_at).await;

        let cleared =
            unhide_dm_recipients(&pool, community_id, dm.id, &sender, message_received_at)
                .await
                .expect("unhide");

        assert!(
            cleared.is_empty(),
            "a hide newer than the message must not be reported as changed"
        );
        assert_eq!(
            current_hidden_at(&pool, community_id, dm.id, &recipient).await,
            Some(hidden_at),
            "the newer hide must survive the delayed resurface"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn unhide_recipients_never_touches_the_sender() {
        let pool = setup_pool().await;
        let community_id = make_test_community(&pool).await;
        let sender = [5u8; 32];
        let recipient = [6u8; 32];
        let dm = create_dm(&pool, community_id, &[&sender, &recipient], &sender)
            .await
            .expect("create dm");

        // Both participants have an old hide; only the recipient may be cleared.
        let hidden_at = Utc::now();
        set_hidden_at(&pool, community_id, dm.id, &sender, hidden_at).await;
        set_hidden_at(&pool, community_id, dm.id, &recipient, hidden_at).await;
        let message_received_at = hidden_at + chrono::Duration::seconds(1);

        let cleared =
            unhide_dm_recipients(&pool, community_id, dm.id, &sender, message_received_at)
                .await
                .expect("unhide");

        assert_eq!(cleared, vec![recipient.to_vec()]);
        assert_eq!(
            current_hidden_at(&pool, community_id, dm.id, &sender).await,
            Some(hidden_at),
            "the sender's own hide must never be rewritten from another surface"
        );
    }
}

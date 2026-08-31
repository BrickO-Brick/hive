//! Transactional persistence for collaborative Project revisions.

use buzz_core::kind::KIND_PROJECT;
use buzz_core::project_revision::{apply_project_revision, can_manage_project, ProjectRevision};
use buzz_core::CommunityId;
use chrono::{DateTime, Utc};
use nostr::Event;
use sqlx::Row;
use uuid::Uuid;

use crate::event::insert_event_in_transaction;
use crate::replaceable::event_replacement_lock_key;
use crate::{Db, DbError, Result};

/// Outcome of applying a Project revision command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectRevisionApplyStatus {
    /// The operation was authorized, current, and persisted.
    Applied,
    /// This exact signed command was already applied.
    Duplicate,
    /// The Project coordinate has no live base event.
    ProjectNotFound,
    /// The expected revision is not the current effective revision.
    Conflict,
    /// The signer is neither the Project owner nor a home-channel owner/admin.
    Forbidden,
    /// The requested add/remove is not valid for current effective state.
    InvalidMutation,
}

/// Result of a Project revision attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectRevisionApplyResult {
    /// Outcome category.
    pub status: ProjectRevisionApplyStatus,
    /// Human-readable detail suitable for a relay rejection.
    pub message: Option<String>,
}

impl ProjectRevisionApplyResult {
    fn status(status: ProjectRevisionApplyStatus) -> Self {
        Self {
            status,
            message: None,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: ProjectRevisionApplyStatus::InvalidMutation,
            message: Some(message.into()),
        }
    }
}

fn tag_values(tags: &serde_json::Value, name: &str) -> Vec<String> {
    tags.as_array()
        .into_iter()
        .flatten()
        .filter_map(|tag| {
            let parts = tag.as_array()?;
            (parts.first()?.as_str()? == name)
                .then(|| parts.get(1)?.as_str().map(ToOwned::to_owned))?
        })
        .collect()
}

fn home_channel(tags: &serde_json::Value) -> Option<Uuid> {
    let values = tag_values(tags, "buzz-channel");
    match values.as_slice() {
        [value] => value.parse().ok(),
        _ => None,
    }
}

fn base_related_channels(tags: &serde_json::Value, home: Option<Uuid>) -> Vec<Uuid> {
    let mut channels = Vec::new();
    for value in tag_values(tags, "buzz-related-channel") {
        if let Ok(channel) = value.parse() {
            if Some(channel) != home && !channels.contains(&channel) && channels.len() < 64 {
                channels.push(channel);
            }
        }
    }
    channels
}

impl Db {
    /// Authorize and atomically apply one actor-signed Project revision.
    pub async fn apply_project_revision(
        &self,
        community_id: CommunityId,
        event: &Event,
        revision: &ProjectRevision,
    ) -> Result<ProjectRevisionApplyResult> {
        let owner = hex::decode(&revision.project.owner)
            .map_err(|error| DbError::InvalidData(format!("invalid Project owner: {error}")))?;
        let actor = event.pubkey.to_bytes();
        let expected = hex::decode(&revision.expected_revision)
            .map_err(|error| DbError::InvalidData(format!("invalid Project revision: {error}")))?;
        let mut tx = self.begin_transaction().await?;

        // Serialize with direct owner replacements of the kind:30621 base.
        let lock_key = event_replacement_lock_key(
            community_id,
            KIND_PROJECT as i32,
            &owner,
            Some(revision.project.slug.as_bytes()),
        );
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(lock_key)
            .execute(&mut *tx)
            .await?;

        // Command retries are idempotent even after the effective head has
        // advanced beyond this event's expected revision.
        let already_applied = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM events WHERE community_id=$1 AND id=$2)",
        )
        .bind(community_id.as_uuid())
        .bind(event.id.as_bytes().as_slice())
        .fetch_one(&mut *tx)
        .await?;
        if already_applied {
            tx.rollback().await?;
            return Ok(ProjectRevisionApplyResult::status(
                ProjectRevisionApplyStatus::Duplicate,
            ));
        }

        let base = sqlx::query(
            "SELECT id, tags FROM events \
             WHERE community_id=$1 AND kind=$2 AND pubkey=$3 AND d_tag=$4 \
               AND deleted_at IS NULL \
             ORDER BY created_at DESC, id ASC LIMIT 1",
        )
        .bind(community_id.as_uuid())
        .bind(KIND_PROJECT as i32)
        .bind(&owner)
        .bind(&revision.project.slug)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(base) = base else {
            tx.rollback().await?;
            return Ok(ProjectRevisionApplyResult::status(
                ProjectRevisionApplyStatus::ProjectNotFound,
            ));
        };
        let base_id: Vec<u8> = base.try_get("id")?;
        let tags: serde_json::Value = base.try_get("tags")?;
        let home = home_channel(&tags);

        let role = if actor.as_slice() == owner.as_slice() {
            None
        } else if let Some(home_channel_id) = home {
            sqlx::query_scalar::<_, String>(
                "SELECT cm.role::text FROM channel_members cm \
                 JOIN channels c ON c.community_id=cm.community_id AND c.id=cm.channel_id \
                 WHERE cm.community_id=$1 AND cm.channel_id=$2 AND cm.pubkey=$3 \
                   AND cm.removed_at IS NULL AND c.deleted_at IS NULL",
            )
            .bind(community_id.as_uuid())
            .bind(home_channel_id)
            .bind(actor.as_slice())
            .fetch_optional(&mut *tx)
            .await?
        } else {
            None
        };
        if !can_manage_project(actor.as_slice(), &owner, role.as_deref()) {
            tx.rollback().await?;
            return Ok(ProjectRevisionApplyResult::status(
                ProjectRevisionApplyStatus::Forbidden,
            ));
        }

        let materialized = sqlx::query(
            "SELECT base_event_id, revision_event_id, related_channel_ids \
             FROM project_revision_heads \
             WHERE community_id=$1 AND project_owner=$2 AND project_d_tag=$3",
        )
        .bind(community_id.as_uuid())
        .bind(&owner)
        .bind(&revision.project.slug)
        .fetch_optional(&mut *tx)
        .await?;

        let (current_revision, mut channels) = match materialized {
            Some(row) if row.try_get::<Vec<u8>, _>("base_event_id")? == base_id => (
                row.try_get::<Vec<u8>, _>("revision_event_id")?,
                row.try_get::<Vec<Uuid>, _>("related_channel_ids")?,
            ),
            _ => (base_id.clone(), base_related_channels(&tags, home)),
        };
        if expected != current_revision {
            tx.rollback().await?;
            return Ok(ProjectRevisionApplyResult::status(
                ProjectRevisionApplyStatus::Conflict,
            ));
        }

        if let Err(message) =
            apply_project_revision(&mut channels, home, revision.operation, revision.channel_id)
        {
            tx.rollback().await?;
            return Ok(ProjectRevisionApplyResult::invalid(message));
        }

        let (_, inserted) = insert_event_in_transaction(&mut tx, community_id, event, None).await?;
        if !inserted {
            tx.rollback().await?;
            return Ok(ProjectRevisionApplyResult::status(
                ProjectRevisionApplyStatus::Duplicate,
            ));
        }

        sqlx::query(
            "INSERT INTO project_revision_heads \
               (community_id, project_owner, project_d_tag, base_event_id, revision_event_id, related_channel_ids, updated_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7) \
             ON CONFLICT (community_id, project_owner, project_d_tag) DO UPDATE SET \
               base_event_id=EXCLUDED.base_event_id, revision_event_id=EXCLUDED.revision_event_id, \
               related_channel_ids=EXCLUDED.related_channel_ids, updated_at=EXCLUDED.updated_at",
        )
        .bind(community_id.as_uuid())
        .bind(&owner)
        .bind(&revision.project.slug)
        .bind(&base_id)
        .bind(event.id.as_bytes().as_slice())
        .bind(&channels)
        .bind(DateTime::<Utc>::from(Utc::now()))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(ProjectRevisionApplyResult::status(
            ProjectRevisionApplyStatus::Applied,
        ))
    }
}

#[cfg(test)]
mod tests {
    use buzz_core::channel::{ChannelType, ChannelVisibility};
    use buzz_core::kind::KIND_PROJECT_REVISION;
    use buzz_core::project_revision::{ProjectCoordinate, ProjectRevisionOperation};
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use sqlx::postgres::PgPoolOptions;

    use super::*;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

    fn project_event(owner: &Keys, slug: &str, home: Option<&str>) -> Event {
        let mut tags = vec![Tag::parse(["d", slug]).unwrap()];
        if let Some(home) = home {
            tags.push(Tag::parse(["buzz-channel", home]).unwrap());
        }
        EventBuilder::new(Kind::Custom(KIND_PROJECT as u16), "")
            .tags(tags)
            .sign_with_keys(owner)
            .unwrap()
    }

    fn revision_event(
        actor: &Keys,
        project: &ProjectCoordinate,
        expected: &str,
        operation: ProjectRevisionOperation,
        channel: Uuid,
    ) -> Event {
        EventBuilder::new(Kind::Custom(KIND_PROJECT_REVISION as u16), "")
            .tags([
                Tag::parse(vec!["a".to_owned(), project.as_string()]).unwrap(),
                Tag::parse(vec!["e".to_owned(), expected.to_owned()]).unwrap(),
                Tag::parse(vec!["op".to_owned(), operation.as_str().to_owned()]).unwrap(),
                Tag::parse(vec!["channel".to_owned(), channel.to_string()]).unwrap(),
            ])
            .sign_with_keys(actor)
            .unwrap()
    }

    #[test]
    fn malformed_or_deleted_home_channel_is_unresolvable() {
        assert_eq!(home_channel(&serde_json::json!([])), None);
        assert_eq!(
            home_channel(&serde_json::json!([["buzz-channel", "not-a-uuid"]])),
            None
        );
        assert_eq!(
            home_channel(&serde_json::json!([
                ["buzz-channel", "11111111-1111-4111-8111-111111111111"],
                ["buzz-channel", "22222222-2222-4222-8222-222222222222"]
            ])),
            None
        );
    }

    #[test]
    fn base_channels_are_bounded_deduplicated_and_exclude_home() {
        let home = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let related = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let tags = serde_json::json!([
            ["buzz-related-channel", home.to_string()],
            ["buzz-related-channel", related.to_string()],
            ["buzz-related-channel", related.to_string()],
            ["buzz-related-channel", "bad"]
        ]);
        assert_eq!(base_related_channels(&tags, Some(home)), vec![related]);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn project_revision_authorization_cas_and_attribution() {
        let database_url =
            std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.into());
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await
            .expect("connect to test DB");
        crate::migration::run_migrations(&pool)
            .await
            .expect("run migrations");
        let db = Db::from_pool(pool.clone());
        let community = CommunityId::from_uuid(Uuid::new_v4());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(format!("project-revision-{}.example", community.as_uuid()))
            .execute(&pool)
            .await
            .unwrap();

        let owner = Keys::generate();
        let home_owner = Keys::generate();
        let admin = Keys::generate();
        let member = Keys::generate();
        let guest = Keys::generate();
        let bot = Keys::generate();
        let unrelated = Keys::generate();
        let home = Uuid::new_v4();
        let related_a = Uuid::new_v4();
        let related_b = Uuid::new_v4();
        crate::channel::create_channel_with_id(
            &pool,
            community,
            home,
            "project-home",
            ChannelType::Stream,
            ChannelVisibility::Open,
            None,
            home_owner.public_key().to_bytes().as_slice(),
            None,
        )
        .await
        .unwrap();
        for (keys, role) in [
            (&admin, "admin"),
            (&member, "member"),
            (&guest, "guest"),
            (&bot, "bot"),
        ] {
            sqlx::query(
                "INSERT INTO channel_members (community_id,channel_id,pubkey,role,invited_by) \
                 VALUES ($1,$2,$3,$4::member_role,$5)",
            )
            .bind(community.as_uuid())
            .bind(home)
            .bind(keys.public_key().to_bytes().as_slice())
            .bind(role)
            .bind(home_owner.public_key().to_bytes().as_slice())
            .execute(&pool)
            .await
            .unwrap();
        }

        let base = project_event(&owner, "shared", Some(&home.to_string()));
        db.insert_event(community, &base, None).await.unwrap();
        let coordinate = ProjectCoordinate {
            owner: owner.public_key().to_hex(),
            slug: "shared".into(),
        };

        let add = revision_event(
            &admin,
            &coordinate,
            &base.id.to_hex(),
            ProjectRevisionOperation::AddRelatedChannel,
            related_a,
        );
        let parsed = ProjectRevision::parse(&add).unwrap();
        assert_eq!(
            db.apply_project_revision(community, &add, &parsed)
                .await
                .unwrap()
                .status,
            ProjectRevisionApplyStatus::Applied
        );
        assert_eq!(
            db.apply_project_revision(community, &add, &parsed)
                .await
                .unwrap()
                .status,
            ProjectRevisionApplyStatus::Duplicate
        );

        for actor in [&member, &guest, &bot, &unrelated] {
            let denied = revision_event(
                actor,
                &coordinate,
                &add.id.to_hex(),
                ProjectRevisionOperation::AddRelatedChannel,
                related_b,
            );
            let parsed = ProjectRevision::parse(&denied).unwrap();
            assert_eq!(
                db.apply_project_revision(community, &denied, &parsed)
                    .await
                    .unwrap()
                    .status,
                ProjectRevisionApplyStatus::Forbidden
            );
        }

        let stale = revision_event(
            &home_owner,
            &coordinate,
            &base.id.to_hex(),
            ProjectRevisionOperation::AddRelatedChannel,
            related_b,
        );
        let parsed = ProjectRevision::parse(&stale).unwrap();
        assert_eq!(
            db.apply_project_revision(community, &stale, &parsed)
                .await
                .unwrap()
                .status,
            ProjectRevisionApplyStatus::Conflict
        );

        let remove = revision_event(
            &owner,
            &coordinate,
            &add.id.to_hex(),
            ProjectRevisionOperation::RemoveRelatedChannel,
            related_a,
        );
        let parsed = ProjectRevision::parse(&remove).unwrap();
        assert_eq!(
            db.apply_project_revision(community, &remove, &parsed)
                .await
                .unwrap()
                .status,
            ProjectRevisionApplyStatus::Applied
        );
        let stored_actor: Vec<u8> =
            sqlx::query_scalar("SELECT pubkey FROM events WHERE community_id=$1 AND id=$2")
                .bind(community.as_uuid())
                .bind(add.id.as_bytes().as_slice())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored_actor, admin.public_key().to_bytes());

        sqlx::query("UPDATE channels SET deleted_at=NOW() WHERE community_id=$1 AND id=$2")
            .bind(community.as_uuid())
            .bind(home)
            .execute(&pool)
            .await
            .unwrap();
        let after_delete = revision_event(
            &admin,
            &coordinate,
            &remove.id.to_hex(),
            ProjectRevisionOperation::AddRelatedChannel,
            related_b,
        );
        let parsed = ProjectRevision::parse(&after_delete).unwrap();
        assert_eq!(
            db.apply_project_revision(community, &after_delete, &parsed)
                .await
                .unwrap()
                .status,
            ProjectRevisionApplyStatus::Forbidden
        );
    }
}

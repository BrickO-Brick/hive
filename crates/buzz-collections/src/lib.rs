//! Local-only Collections model and SQLite persistence shared by Buzz Desktop and `buzz-cli`.
//!
//! Collections are deliberately scoped to one relay community and owner identity.
//! The relay remains untouched: this crate is the prototype's single local source
//! of truth until the model is ready for a portable Nostr representation.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

const PROD_BUNDLE_IDENTIFIER: &str = "xyz.block.buzz.app";
const PROFILE_DATA_DIR: &str = "xyz.block.buzz.collections";
const DB_FILENAME: &str = "collections.sqlite3";
const MAX_PROFILE_LEN: usize = 64;
const MAX_NAME_LEN: usize = 120;
const MAX_DESCRIPTION_LEN: usize = 4_000;
const MAX_ICON_LEN: usize = 32;
const MAX_LABEL_LEN: usize = 512;

/// Errors returned by Collections validation and persistence.
#[derive(Debug, thiserror::Error)]
pub enum CollectionsError {
    /// A caller supplied an invalid scope, collection field, or reference.
    #[error("invalid collections input: {0}")]
    Validation(String),
    /// The requested collection or member does not exist in this scope.
    #[error("{0}")]
    NotFound(String),
    /// The local platform data directory could not be resolved.
    #[error("could not resolve the platform app-data directory")]
    DataDirectoryUnavailable,
    /// SQLite rejected a store operation.
    #[error("collections database error: {0}")]
    Database(#[from] rusqlite::Error),
    /// A stored reference could not be decoded.
    #[error("invalid collections data: {0}")]
    Corrupt(String),
    /// A reference could not be serialized.
    #[error("collections serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    /// The store directory could not be created.
    #[error("failed to prepare collections store: {0}")]
    Io(#[from] std::io::Error),
}

/// Community and owner boundary for local Collections state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionScope {
    /// Canonical WebSocket relay URL selecting the community.
    pub relay_url: String,
    /// Lowercase hex owner pubkey. Agents use their NIP-OA owner when present.
    pub owner_pubkey: String,
}

impl CollectionScope {
    /// Validate and canonicalize a relay URL and owner pubkey.
    pub fn new(relay_url: &str, owner_pubkey: &str) -> Result<Self, CollectionsError> {
        Ok(Self {
            relay_url: normalize_relay_url(relay_url)?,
            owner_pubkey: normalize_hex64(owner_pubkey, "owner pubkey")?,
        })
    }
}

/// A locally persisted Collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Collection {
    /// Stable local UUID.
    pub id: Uuid,
    /// Canonical relay URL selecting the community.
    pub relay_url: String,
    /// Owner identity for this Collection.
    pub owner_pubkey: String,
    /// Human-readable name, unique within the scope ignoring case.
    pub name: String,
    /// Optional human-readable description.
    pub description: Option<String>,
    /// Optional emoji or short icon text chosen by the user.
    pub icon: Option<String>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Last membership or metadata change time.
    pub updated_at: DateTime<Utc>,
}

/// A validated reference to content grouped by a Collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CollectionReference {
    /// A NIP-29 channel UUID.
    Channel { channel_id: Uuid },
    /// A NIP-34 repository coordinate (`30617:<owner>:<d-tag>`).
    Repository { coordinate: String },
    /// A repository-linked NIP-34 issue.
    Task {
        event_id: String,
        repository: String,
    },
    /// A channel thread identified by its root event.
    Thread {
        channel_id: Uuid,
        root_event_id: String,
    },
    /// An individual channel message.
    Message { channel_id: Uuid, event_id: String },
    /// A NIP-23 long-form note coordinate (`30023:<owner>:<d-tag>`).
    Note { coordinate: String },
    /// An arbitrary HTTP(S) reference outside Buzz.
    External { url: String },
}

impl CollectionReference {
    /// Construct a channel reference.
    pub fn channel(channel_id: &str) -> Result<Self, CollectionsError> {
        Ok(Self::Channel {
            channel_id: parse_uuid(channel_id, "channel ID")?,
        })
    }

    /// Construct a repository reference.
    pub fn repository(coordinate: &str) -> Result<Self, CollectionsError> {
        Ok(Self::Repository {
            coordinate: normalize_coordinate(coordinate, 30_617, "repository")?,
        })
    }

    /// Construct a repository-linked task reference.
    pub fn task(event_id: &str, repository: &str) -> Result<Self, CollectionsError> {
        Ok(Self::Task {
            event_id: normalize_hex64(event_id, "task event ID")?,
            repository: normalize_coordinate(repository, 30_617, "repository")?,
        })
    }

    /// Construct a thread reference.
    pub fn thread(channel_id: &str, root_event_id: &str) -> Result<Self, CollectionsError> {
        Ok(Self::Thread {
            channel_id: parse_uuid(channel_id, "channel ID")?,
            root_event_id: normalize_hex64(root_event_id, "thread root event ID")?,
        })
    }

    /// Construct an individual message reference.
    pub fn message(channel_id: &str, event_id: &str) -> Result<Self, CollectionsError> {
        Ok(Self::Message {
            channel_id: parse_uuid(channel_id, "channel ID")?,
            event_id: normalize_hex64(event_id, "message event ID")?,
        })
    }

    /// Construct a NIP-23 long-form note reference.
    pub fn note(coordinate: &str) -> Result<Self, CollectionsError> {
        Ok(Self::Note {
            coordinate: normalize_coordinate(coordinate, 30_023, "note")?,
        })
    }

    /// Construct an external HTTP(S) reference.
    pub fn external(url: &str) -> Result<Self, CollectionsError> {
        Ok(Self::External {
            url: normalize_external_url(url)?,
        })
    }

    fn normalized(&self) -> Result<Self, CollectionsError> {
        match self {
            Self::Channel { channel_id } => Self::channel(&channel_id.to_string()),
            Self::Repository { coordinate } => Self::repository(coordinate),
            Self::Task {
                event_id,
                repository,
            } => Self::task(event_id, repository),
            Self::Thread {
                channel_id,
                root_event_id,
            } => Self::thread(&channel_id.to_string(), root_event_id),
            Self::Message {
                channel_id,
                event_id,
            } => Self::message(&channel_id.to_string(), event_id),
            Self::Note { coordinate } => Self::note(coordinate),
            Self::External { url } => Self::external(url),
        }
    }

    fn kind_and_key(&self) -> Result<(&'static str, String), CollectionsError> {
        let normalized = self.normalized()?;
        Ok(match normalized {
            Self::Channel { channel_id } => ("channel", channel_id.to_string()),
            Self::Repository { coordinate } => ("repository", coordinate),
            Self::Task {
                event_id,
                repository,
            } => ("task", format!("{repository}|{event_id}")),
            Self::Thread {
                channel_id,
                root_event_id,
            } => ("thread", format!("{channel_id}|{root_event_id}")),
            Self::Message {
                channel_id,
                event_id,
            } => ("message", format!("{channel_id}|{event_id}")),
            Self::Note { coordinate } => ("note", coordinate),
            Self::External { url } => ("external", url),
        })
    }
}

/// One Collection membership edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionMember {
    /// Stable UUID for removing this membership.
    pub id: Uuid,
    /// Parent Collection UUID.
    pub collection_id: Uuid,
    /// Canonical typed content reference.
    pub reference: CollectionReference,
    /// Optional cached display label; never used as identity.
    pub label: Option<String>,
    /// Time this membership was created.
    pub added_at: DateTime<Utc>,
}

/// A Collection and its ordered membership list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionWithMembers {
    /// Collection metadata.
    pub collection: Collection,
    /// Membership edges, newest first.
    pub members: Vec<CollectionMember>,
}

/// Resolve the shared Collections database path.
///
/// `BUZZ_COLLECTIONS_DB` overrides the default for isolated tests and explicit
/// production-data prototypes. `BUZZ_COLLECTIONS_PROFILE` selects an isolated,
/// named local profile shared with Desktop. Release builds without either
/// override use the installed app's production data path.
pub fn collections_db_path() -> Result<PathBuf, CollectionsError> {
    if let Some(path) = collections_db_override() {
        return Ok(path);
    }
    let data_dir = dirs::data_dir().ok_or(CollectionsError::DataDirectoryUnavailable)?;
    if let Some(profile) = collections_profile()? {
        return Ok(profile_db_path(&data_dir, &profile));
    }
    if cfg!(debug_assertions) {
        return Err(CollectionsError::Validation(
            "debug buzz collections requires BUZZ_COLLECTIONS_PROFILE; use `just collections ...`"
                .into(),
        ));
    }
    Ok(data_dir.join(PROD_BUNDLE_IDENTIFIER).join(DB_FILENAME))
}

/// Resolve the Collections database relative to a Tauri app-data directory.
///
/// Explicit database overrides remain authoritative. A named profile resolves
/// beside application data, never inside or by copying the installed app's
/// production directory. Without a profile, Desktop keeps its bundle-specific
/// app-data isolation.
pub fn collections_db_path_for_app_data_dir(
    app_data_dir: &Path,
) -> Result<PathBuf, CollectionsError> {
    if let Some(path) = collections_db_override() {
        return Ok(path);
    }
    if let Some(profile) = collections_profile()? {
        let data_dir = app_data_dir
            .parent()
            .ok_or(CollectionsError::DataDirectoryUnavailable)?;
        return Ok(profile_db_path(data_dir, &profile));
    }
    Ok(app_data_dir.join(DB_FILENAME))
}

fn collections_db_override() -> Option<PathBuf> {
    std::env::var_os("BUZZ_COLLECTIONS_DB")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

fn collections_profile() -> Result<Option<String>, CollectionsError> {
    std::env::var("BUZZ_COLLECTIONS_PROFILE")
        .ok()
        .filter(|profile| !profile.is_empty())
        .map(|profile| normalize_profile(&profile))
        .transpose()
}

fn normalize_profile(raw: &str) -> Result<String, CollectionsError> {
    if raw != raw.trim()
        || raw.is_empty()
        || raw.len() > MAX_PROFILE_LEN
        || !raw.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
        || !raw
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(CollectionsError::Validation(
            "collections profile must be 1-64 lowercase letters, digits, dots, underscores, or hyphens and start with a letter or digit"
                .into(),
        ));
    }
    Ok(raw.to_string())
}

fn profile_db_path(data_dir: &Path, profile: &str) -> PathBuf {
    data_dir
        .join(PROFILE_DATA_DIR)
        .join(profile)
        .join(DB_FILENAME)
}

/// Synchronous SQLite store. Callers from async runtimes should use a blocking task.
pub struct CollectionsStore {
    connection: Connection,
}

impl CollectionsStore {
    /// Open or create the Collections database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, CollectionsError> {
        let path = path.as_ref();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        Self::initialize(connection)
    }

    /// Open an in-memory Collections database, primarily for tests.
    pub fn in_memory() -> Result<Self, CollectionsError> {
        Self::initialize(Connection::open_in_memory()?)
    }

    fn initialize(mut connection: Connection) -> Result<Self, CollectionsError> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS collections (
               id TEXT PRIMARY KEY NOT NULL,
               relay_url TEXT NOT NULL,
               owner_pubkey TEXT NOT NULL,
               name TEXT NOT NULL,
               description TEXT,
               icon TEXT,
               created_at_ms INTEGER NOT NULL,
               updated_at_ms INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS collections_scope_name
               ON collections(relay_url, owner_pubkey, name COLLATE NOCASE);
             CREATE INDEX IF NOT EXISTS collections_scope_updated
               ON collections(relay_url, owner_pubkey, updated_at_ms DESC);
             CREATE TABLE IF NOT EXISTS collection_members (
               id TEXT PRIMARY KEY NOT NULL,
               collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
               reference_kind TEXT NOT NULL,
               reference_key TEXT NOT NULL,
               reference_json TEXT NOT NULL,
               label TEXT,
               added_at_ms INTEGER NOT NULL,
               UNIQUE(collection_id, reference_kind, reference_key)
             );
             CREATE INDEX IF NOT EXISTS collection_members_collection
               ON collection_members(collection_id, added_at_ms DESC);",
        )?;
        let migration = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_icon_column(&migration)?;
        migration.commit()?;
        Ok(Self { connection })
    }

    /// Create a Collection in `scope`.
    pub fn create_collection(
        &mut self,
        scope: &CollectionScope,
        name: &str,
        description: Option<&str>,
        icon: Option<&str>,
    ) -> Result<Collection, CollectionsError> {
        let name = normalize_required_text(name, "collection name", MAX_NAME_LEN)?;
        let description = normalize_optional_text(description, "description", MAX_DESCRIPTION_LEN)?;
        let icon = normalize_optional_text(icon, "collection icon", MAX_ICON_LEN)?;
        let now = Utc::now();
        let collection = Collection {
            id: Uuid::new_v4(),
            relay_url: scope.relay_url.clone(),
            owner_pubkey: scope.owner_pubkey.clone(),
            name,
            description,
            icon,
            created_at: now,
            updated_at: now,
        };
        let result = self.connection.execute(
            "INSERT INTO collections
             (id, relay_url, owner_pubkey, name, description, icon, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                collection.id.to_string(),
                collection.relay_url,
                collection.owner_pubkey,
                collection.name,
                collection.description,
                collection.icon,
                collection.created_at.timestamp_millis(),
                collection.updated_at.timestamp_millis(),
            ],
        );
        match result {
            Ok(_) => Ok(collection),
            Err(error) if is_unique_violation(&error) => Err(CollectionsError::Validation(
                "a collection with that name already exists in this community".into(),
            )),
            Err(error) => Err(error.into()),
        }
    }

    /// List Collections in a scope, most recently changed first.
    pub fn list_collections(
        &self,
        scope: &CollectionScope,
    ) -> Result<Vec<Collection>, CollectionsError> {
        let mut statement = self.connection.prepare(
            "SELECT id, relay_url, owner_pubkey, name, description, icon, created_at_ms, updated_at_ms
             FROM collections WHERE relay_url = ?1 AND owner_pubkey = ?2
             ORDER BY updated_at_ms DESC, name COLLATE NOCASE ASC",
        )?;
        let rows = statement.query_map(
            params![scope.relay_url, scope.owner_pubkey],
            read_collection_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Read one Collection and all memberships in the same scope.
    pub fn get_collection(
        &self,
        scope: &CollectionScope,
        collection_id: Uuid,
    ) -> Result<CollectionWithMembers, CollectionsError> {
        let collection = self
            .connection
            .query_row(
                "SELECT id, relay_url, owner_pubkey, name, description, icon, created_at_ms, updated_at_ms
                 FROM collections WHERE id = ?1 AND relay_url = ?2 AND owner_pubkey = ?3",
                params![collection_id.to_string(), scope.relay_url, scope.owner_pubkey],
                read_collection_row,
            )
            .optional()?
            .ok_or_else(|| CollectionsError::NotFound(format!("collection {collection_id} not found")))?;
        let mut statement = self.connection.prepare(
            "SELECT id, collection_id, reference_json, label, added_at_ms
             FROM collection_members WHERE collection_id = ?1
             ORDER BY added_at_ms DESC, id ASC",
        )?;
        let raw = statement.query_map(params![collection_id.to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        let members = raw
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(decode_member)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CollectionWithMembers {
            collection,
            members,
        })
    }

    /// Set or clear the optional icon for a Collection in this scope.
    pub fn set_collection_icon(
        &mut self,
        scope: &CollectionScope,
        collection_id: Uuid,
        icon: Option<&str>,
    ) -> Result<Collection, CollectionsError> {
        let icon = icon
            .map(|value| normalize_required_text(value, "collection icon", MAX_ICON_LEN))
            .transpose()?;
        let now = Utc::now();
        let changed = self.connection.execute(
            "UPDATE collections SET icon = ?1, updated_at_ms = ?2
             WHERE id = ?3 AND relay_url = ?4 AND owner_pubkey = ?5",
            params![
                icon,
                now.timestamp_millis(),
                collection_id.to_string(),
                scope.relay_url,
                scope.owner_pubkey,
            ],
        )?;
        if changed == 0 {
            return Err(CollectionsError::NotFound(format!(
                "collection {collection_id} not found"
            )));
        }
        self.get_collection(scope, collection_id)
            .map(|collection| collection.collection)
    }

    /// Rename a Collection in this scope without changing its memberships.
    pub fn set_collection_name(
        &mut self,
        scope: &CollectionScope,
        collection_id: Uuid,
        name: &str,
    ) -> Result<Collection, CollectionsError> {
        let name = normalize_required_text(name, "collection name", MAX_NAME_LEN)?;
        let now = Utc::now();
        let result = self.connection.execute(
            "UPDATE collections SET name = ?1, updated_at_ms = ?2
             WHERE id = ?3 AND relay_url = ?4 AND owner_pubkey = ?5",
            params![
                name,
                now.timestamp_millis(),
                collection_id.to_string(),
                scope.relay_url,
                scope.owner_pubkey,
            ],
        );
        match result {
            Ok(0) => Err(CollectionsError::NotFound(format!(
                "collection {collection_id} not found"
            ))),
            Ok(_) => self
                .get_collection(scope, collection_id)
                .map(|collection| collection.collection),
            Err(error) if is_unique_violation(&error) => Err(CollectionsError::Validation(
                "a collection with that name already exists in this community".into(),
            )),
            Err(error) => Err(error.into()),
        }
    }

    /// Delete a Collection and its membership edges from this scope.
    pub fn delete_collection(
        &mut self,
        scope: &CollectionScope,
        collection_id: Uuid,
    ) -> Result<(), CollectionsError> {
        let changed = self.connection.execute(
            "DELETE FROM collections WHERE id = ?1 AND relay_url = ?2 AND owner_pubkey = ?3",
            params![
                collection_id.to_string(),
                scope.relay_url,
                scope.owner_pubkey
            ],
        )?;
        if changed == 0 {
            return Err(CollectionsError::NotFound(format!(
                "collection {collection_id} not found"
            )));
        }
        Ok(())
    }

    /// Add a membership edge. Repeating the same add returns the existing edge.
    pub fn add_member(
        &mut self,
        scope: &CollectionScope,
        collection_id: Uuid,
        reference: &CollectionReference,
        label: Option<&str>,
    ) -> Result<CollectionMember, CollectionsError> {
        let reference = reference.normalized()?;
        let (reference_kind, reference_key) = reference.kind_and_key()?;
        let label = normalize_optional_text(label, "member label", MAX_LABEL_LEN)?;
        let reference_json = serde_json::to_string(&reference)?;
        let now = Utc::now();
        let member_id = Uuid::new_v4();
        let transaction = self.connection.transaction()?;
        let collection_exists = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM collections WHERE id = ?1 AND relay_url = ?2 AND owner_pubkey = ?3
             )",
            params![
                collection_id.to_string(),
                scope.relay_url,
                scope.owner_pubkey
            ],
            |row| row.get::<_, bool>(0),
        )?;
        if !collection_exists {
            return Err(CollectionsError::NotFound(format!(
                "collection {collection_id} not found"
            )));
        }
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO collection_members
             (id, collection_id, reference_kind, reference_key, reference_json, label, added_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                member_id.to_string(),
                collection_id.to_string(),
                reference_kind,
                reference_key,
                reference_json,
                label,
                now.timestamp_millis(),
            ],
        )?;
        if inserted > 0 {
            transaction.execute(
                "UPDATE collections SET updated_at_ms = ?1 WHERE id = ?2",
                params![now.timestamp_millis(), collection_id.to_string()],
            )?;
        }
        let raw = transaction.query_row(
            "SELECT id, collection_id, reference_json, label, added_at_ms
             FROM collection_members
             WHERE collection_id = ?1 AND reference_kind = ?2 AND reference_key = ?3",
            params![collection_id.to_string(), reference_kind, reference_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )?;
        transaction.commit()?;
        decode_member(raw)
    }

    /// Remove one membership edge from a Collection in this scope.
    pub fn remove_member(
        &mut self,
        scope: &CollectionScope,
        collection_id: Uuid,
        member_id: Uuid,
    ) -> Result<(), CollectionsError> {
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute(
            "DELETE FROM collection_members
             WHERE id = ?1 AND collection_id = ?2 AND EXISTS(
               SELECT 1 FROM collections
               WHERE id = ?2 AND relay_url = ?3 AND owner_pubkey = ?4
             )",
            params![
                member_id.to_string(),
                collection_id.to_string(),
                scope.relay_url,
                scope.owner_pubkey,
            ],
        )?;
        if changed == 0 {
            return Err(CollectionsError::NotFound(format!(
                "member {member_id} not found in collection {collection_id}"
            )));
        }
        transaction.execute(
            "UPDATE collections SET updated_at_ms = ?1 WHERE id = ?2",
            params![Utc::now().timestamp_millis(), collection_id.to_string()],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn normalize_relay_url(raw: &str) -> Result<String, CollectionsError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(CollectionsError::Validation("relay URL is required".into()));
    }
    let mut parsed = Url::parse(raw)
        .map_err(|error| CollectionsError::Validation(format!("invalid relay URL: {error}")))?;
    let canonical_scheme = match parsed.scheme() {
        "ws" | "http" => "ws",
        "wss" | "https" => "wss",
        scheme => {
            return Err(CollectionsError::Validation(format!(
                "relay URL scheme must be ws, wss, http, or https (got {scheme})"
            )))
        }
    };
    parsed
        .set_scheme(canonical_scheme)
        .map_err(|_| CollectionsError::Validation("invalid relay URL scheme".into()))?;
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CollectionsError::Validation(
            "relay URL must have a host and cannot contain credentials".into(),
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(CollectionsError::Validation(
            "relay URL cannot contain a query or fragment".into(),
        ));
    }
    let path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&path);
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn normalize_external_url(raw: &str) -> Result<String, CollectionsError> {
    let mut parsed = Url::parse(raw.trim())
        .map_err(|error| CollectionsError::Validation(format!("invalid external URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(CollectionsError::Validation(
            "external URL must be an absolute http or https URL".into(),
        ));
    }
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

fn normalize_coordinate(
    raw: &str,
    expected_kind: u32,
    label: &str,
) -> Result<String, CollectionsError> {
    let mut parts = raw.trim().splitn(3, ':');
    let kind = parts.next().unwrap_or_default();
    let pubkey = parts.next().unwrap_or_default();
    let identifier = parts.next().unwrap_or_default();
    if kind.parse::<u32>().ok() != Some(expected_kind) {
        return Err(CollectionsError::Validation(format!(
            "{label} coordinate must start with {expected_kind}:"
        )));
    }
    let pubkey = normalize_hex64(pubkey, &format!("{label} owner pubkey"))?;
    if identifier.is_empty() || identifier.chars().any(char::is_control) {
        return Err(CollectionsError::Validation(format!(
            "{label} coordinate requires a non-empty d-tag"
        )));
    }
    Ok(format!("{expected_kind}:{pubkey}:{identifier}"))
}

fn normalize_hex64(raw: &str, label: &str) -> Result<String, CollectionsError> {
    let raw = raw.trim();
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CollectionsError::Validation(format!(
            "{label} must be 64 hexadecimal characters"
        )));
    }
    Ok(raw.to_ascii_lowercase())
}

fn parse_uuid(raw: &str, label: &str) -> Result<Uuid, CollectionsError> {
    Uuid::parse_str(raw.trim())
        .map_err(|_| CollectionsError::Validation(format!("{label} must be a UUID")))
}

fn normalize_required_text(
    raw: &str,
    label: &str,
    max_len: usize,
) -> Result<String, CollectionsError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(CollectionsError::Validation(format!("{label} is required")));
    }
    if value.chars().count() > max_len || value.chars().any(char::is_control) {
        return Err(CollectionsError::Validation(format!(
            "{label} must be at most {max_len} characters and contain no control characters"
        )));
    }
    Ok(value.to_string())
}

fn normalize_optional_text(
    raw: Option<&str>,
    label: &str,
    max_len: usize,
) -> Result<Option<String>, CollectionsError> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| normalize_required_text(value, label, max_len))
        .transpose()
}

fn ensure_icon_column(connection: &Connection) -> Result<(), CollectionsError> {
    let mut statement = connection.prepare("PRAGMA table_info(collections)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|column| column == "icon") {
        connection.execute("ALTER TABLE collections ADD COLUMN icon TEXT", [])?;
    }
    Ok(())
}

fn read_collection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Collection> {
    let id = row.get::<_, String>(0)?;
    let created_at_ms = row.get::<_, i64>(6)?;
    let updated_at_ms = row.get::<_, i64>(7)?;
    Ok(Collection {
        id: Uuid::parse_str(&id).map_err(|error| conversion_error(0, error))?,
        relay_url: row.get(1)?,
        owner_pubkey: row.get(2)?,
        name: row.get(3)?,
        description: row.get(4)?,
        icon: row.get(5)?,
        created_at: timestamp(created_at_ms).map_err(|error| conversion_error(6, error))?,
        updated_at: timestamp(updated_at_ms).map_err(|error| conversion_error(7, error))?,
    })
}

fn decode_member(
    raw: (String, String, String, Option<String>, i64),
) -> Result<CollectionMember, CollectionsError> {
    let (id, collection_id, reference_json, label, added_at_ms) = raw;
    Ok(CollectionMember {
        id: Uuid::parse_str(&id)
            .map_err(|error| CollectionsError::Corrupt(format!("invalid member UUID: {error}")))?,
        collection_id: Uuid::parse_str(&collection_id).map_err(|error| {
            CollectionsError::Corrupt(format!("invalid collection UUID: {error}"))
        })?,
        reference: serde_json::from_str(&reference_json)?,
        label,
        added_at: timestamp(added_at_ms)?,
    })
}

fn timestamp(milliseconds: i64) -> Result<DateTime<Utc>, CollectionsError> {
    DateTime::from_timestamp_millis(milliseconds).ok_or_else(|| {
        CollectionsError::Corrupt(format!("invalid timestamp milliseconds: {milliseconds}"))
    })
}

fn conversion_error(
    column: usize,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}

fn is_unique_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OWNER_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const EVENT: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const CHANNEL: &str = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";

    fn scope(relay: &str, owner: &str) -> CollectionScope {
        CollectionScope::new(relay, owner).expect("scope")
    }

    #[test]
    fn scope_canonicalizes_transport_and_identity() {
        let scope = CollectionScope::new("https://BUZZ.Example/", &OWNER_A.to_uppercase())
            .expect("valid scope");
        assert_eq!(scope.relay_url, "wss://buzz.example");
        assert_eq!(scope.owner_pubkey, OWNER_A);
    }

    #[test]
    fn blank_optional_text_is_absent() {
        assert_eq!(
            normalize_optional_text(Some("   "), "description", MAX_DESCRIPTION_LEN)
                .expect("normalize"),
            None
        );
    }

    #[test]
    fn named_profiles_are_validated_and_isolated_from_app_data() {
        assert_eq!(normalize_profile("dev.main").expect("profile"), "dev.main");
        assert_eq!(
            profile_db_path(Path::new("/data"), "dev.feature-one"),
            Path::new("/data")
                .join(PROFILE_DATA_DIR)
                .join("dev.feature-one")
                .join(DB_FILENAME)
        );
        for invalid in [
            "",
            " Dev",
            "dev/../../production",
            "UPPERCASE",
            ".hidden",
            &"x".repeat(MAX_PROFILE_LEN + 1),
        ] {
            assert!(normalize_profile(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn references_validate_and_normalize_stable_identity() {
        assert_eq!(
            CollectionReference::repository(&format!("30617:{}:Buzz", OWNER_A.to_uppercase()))
                .expect("repo"),
            CollectionReference::Repository {
                coordinate: format!("30617:{OWNER_A}:Buzz")
            }
        );
        assert!(CollectionReference::task(EVENT, "30023:bad:note").is_err());
        assert!(CollectionReference::external("javascript:alert(1)").is_err());
    }

    #[test]
    fn crud_is_scoped_by_community_and_owner() {
        let mut store = CollectionsStore::in_memory().expect("store");
        let a = scope("wss://one.example", OWNER_A);
        let b = scope("wss://one.example", OWNER_B);
        let c = scope("wss://two.example", OWNER_A);
        let collection = store
            .create_collection(&a, "Bird Voice", Some("Voice work"), Some(" 🐦 "))
            .expect("create");

        assert_eq!(collection.icon.as_deref(), Some("🐦"));

        assert_eq!(store.list_collections(&a).expect("list").len(), 1);
        assert!(store.list_collections(&b).expect("list").is_empty());
        assert!(store.list_collections(&c).expect("list").is_empty());
        assert!(matches!(
            store.get_collection(&b, collection.id),
            Err(CollectionsError::NotFound(_))
        ));
    }

    #[test]
    fn icon_can_be_set_changed_and_cleared() {
        let mut store = CollectionsStore::in_memory().expect("store");
        let scope = scope("wss://buzz.example", OWNER_A);
        let collection = store
            .create_collection(&scope, "Bird Voice", None, None)
            .expect("create");

        let updated = store
            .set_collection_icon(&scope, collection.id, Some(" 🐦️ "))
            .expect("set icon");
        assert_eq!(updated.icon.as_deref(), Some("🐦️"));

        let cleared = store
            .set_collection_icon(&scope, collection.id, None)
            .expect("clear icon");
        assert_eq!(cleared.icon, None);
        assert!(store
            .set_collection_icon(&scope, collection.id, Some("bad\nicon"))
            .is_err());
        assert!(store
            .set_collection_icon(&scope, collection.id, Some("   "))
            .is_err());
        assert!(store
            .set_collection_icon(&scope, collection.id, Some(&"x".repeat(MAX_ICON_LEN + 1)))
            .is_err());
    }

    #[test]
    fn rename_preserves_identity_and_memberships() {
        let mut store = CollectionsStore::in_memory().expect("store");
        let scope = scope("wss://buzz.example", OWNER_A);
        let collection = store
            .create_collection(&scope, "Bird Voice", None, Some("🐦"))
            .expect("create");
        let member = store
            .add_member(
                &scope,
                collection.id,
                &CollectionReference::channel(CHANNEL).expect("channel"),
                None,
            )
            .expect("member");

        let renamed = store
            .set_collection_name(&scope, collection.id, " Berd Voice ")
            .expect("rename");
        assert_eq!(renamed.id, collection.id);
        assert_eq!(renamed.name, "Berd Voice");
        assert_eq!(renamed.icon, collection.icon);
        let reloaded = store
            .get_collection(&scope, collection.id)
            .expect("reloaded");
        assert_eq!(reloaded.members, vec![member]);
        assert!(store
            .set_collection_name(&scope, collection.id, "bad\nname")
            .is_err());
    }

    #[test]
    fn opening_legacy_database_adds_nullable_icon_column() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("legacy.sqlite3");
        let connection = Connection::open(&path).expect("legacy connection");
        connection
            .execute_batch(
                "CREATE TABLE collections (
                   id TEXT PRIMARY KEY NOT NULL,
                   relay_url TEXT NOT NULL,
                   owner_pubkey TEXT NOT NULL,
                   name TEXT NOT NULL,
                   description TEXT,
                   created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );",
            )
            .expect("legacy schema");
        let legacy_id = Uuid::new_v4();
        connection
            .execute(
                "INSERT INTO collections
                 (id, relay_url, owner_pubkey, name, description, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, NULL, 1, 1)",
                params![
                    legacy_id.to_string(),
                    "wss://buzz.example",
                    OWNER_A,
                    "Legacy"
                ],
            )
            .expect("legacy row");
        drop(connection);

        let store = CollectionsStore::open(&path).expect("migrated store");
        let legacy = store
            .get_collection(&scope("wss://buzz.example", OWNER_A), legacy_id)
            .expect("preserved legacy collection")
            .collection;
        assert_eq!(legacy.name, "Legacy");
        assert_eq!(legacy.icon, None);
        let columns = store
            .connection
            .prepare("PRAGMA table_info(collections)")
            .expect("prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect columns");
        assert!(columns.iter().any(|column| column == "icon"));
    }

    #[test]
    fn membership_is_idempotent_and_many_to_many() {
        let mut store = CollectionsStore::in_memory().expect("store");
        let scope = scope("wss://buzz.example", OWNER_A);
        let first = store
            .create_collection(&scope, "First", None, None)
            .expect("first");
        let second = store
            .create_collection(&scope, "Second", None, None)
            .expect("second");
        let reference = CollectionReference::message(CHANNEL, EVENT).expect("message");

        let edge = store
            .add_member(&scope, first.id, &reference, Some("Decision"))
            .expect("add");
        let repeated = store
            .add_member(&scope, first.id, &reference, Some("Ignored replacement"))
            .expect("repeat");
        let other = store
            .add_member(&scope, second.id, &reference, None)
            .expect("other collection");

        assert_eq!(edge.id, repeated.id);
        assert_eq!(repeated.label.as_deref(), Some("Decision"));
        assert_ne!(edge.id, other.id);
        assert_eq!(
            store
                .get_collection(&scope, first.id)
                .expect("get")
                .members
                .len(),
            1
        );
        assert_eq!(
            store
                .get_collection(&scope, second.id)
                .expect("get")
                .members
                .len(),
            1
        );
    }

    #[test]
    fn delete_cascades_memberships() {
        let mut store = CollectionsStore::in_memory().expect("store");
        let scope = scope("wss://buzz.example", OWNER_A);
        let collection = store
            .create_collection(&scope, "Temporary", None, None)
            .expect("create");
        let member = store
            .add_member(
                &scope,
                collection.id,
                &CollectionReference::channel(CHANNEL).expect("channel"),
                None,
            )
            .expect("member");
        store
            .delete_collection(&scope, collection.id)
            .expect("delete");

        let count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM collection_members WHERE id = ?1",
                params![member.id.to_string()],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 0);
    }

    #[test]
    fn file_store_supports_multiple_writers() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("collections.sqlite3");
        let scope = scope("wss://buzz.example", OWNER_A);
        let mut first = CollectionsStore::open(&path).expect("first store");
        let mut second = CollectionsStore::open(&path).expect("second store");

        first
            .create_collection(&scope, "One", None, None)
            .expect("first write");
        second
            .create_collection(&scope, "Two", None, None)
            .expect("second write");

        assert_eq!(first.list_collections(&scope).expect("list").len(), 2);
    }
}

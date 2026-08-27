use buzz_collections::{
    collections_db_path, CollectionReference, CollectionScope, CollectionsError, CollectionsStore,
};
use clap::Subcommand;
use uuid::Uuid;

use crate::{client::BuzzClient, error::CliError};

#[derive(Subcommand)]
#[command(
    after_long_help = "The `get` JSON is the stable stored input for a Collection home: metadata plus ordered typed membership edges. Agents can compose those references with the existing channels, messages, repos, issues, and notes commands. Optional Desktop Calendar and GitHub activity is derived at read time through locally connected `sq` and `gh`; it is never persisted or imported into this OSS CLI."
)]
pub enum CollectionsCmd {
    /// Create a local Collection
    Create {
        /// Human-readable Collection name
        #[arg(long)]
        name: String,
        /// Optional Collection description
        #[arg(long)]
        description: Option<String>,
        /// Optional emoji or short icon text
        #[arg(long)]
        icon: Option<String>,
    },
    /// List local Collections for the current community and owner
    #[command(name = "ls", visible_alias = "list")]
    Ls,
    /// Get one Collection's stored home input and ordered members
    Get {
        /// Collection UUID
        #[arg(long)]
        collection: String,
    },
    /// Set a Collection's emoji or short icon text
    SetIcon {
        /// Collection UUID
        #[arg(long)]
        collection: String,
        /// Emoji or short icon text
        #[arg(long)]
        icon: String,
    },
    /// Clear a Collection's icon
    ClearIcon {
        /// Collection UUID
        #[arg(long)]
        collection: String,
    },
    /// Rename a Collection
    Rename {
        /// Collection UUID
        #[arg(long)]
        collection: String,
        /// New human-readable Collection name
        #[arg(long)]
        name: String,
    },
    /// Delete a local Collection
    Rm {
        /// Collection UUID
        #[arg(long)]
        collection: String,
    },
    /// Add an item to a Collection
    Add {
        /// Collection UUID
        #[arg(long)]
        collection: String,
        #[command(subcommand)]
        reference: CollectionReferenceCmd,
    },
    /// Remove a membership edge from a Collection
    Remove {
        /// Collection UUID
        #[arg(long)]
        collection: String,
        /// Membership UUID returned by get/add
        #[arg(long)]
        member: String,
    },
}

#[derive(Subcommand)]
pub enum CollectionReferenceCmd {
    /// Add a channel
    Channel {
        #[arg(long)]
        channel: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Add a NIP-34 repository
    Repository {
        #[arg(long)]
        repo: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Add a repository-linked task
    Task {
        #[arg(long)]
        event: String,
        #[arg(long)]
        repo: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Add a channel thread
    Thread {
        #[arg(long)]
        channel: String,
        #[arg(long)]
        event: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Add an individual message
    Message {
        #[arg(long)]
        channel: String,
        #[arg(long)]
        event: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Add a NIP-23 note
    Note {
        /// NIP-33 coordinate (`kind:pubkey:identifier`)
        #[arg(long)]
        coordinate: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Add an external HTTP(S) URL
    External {
        #[arg(long)]
        url: String,
        #[arg(long)]
        label: Option<String>,
    },
}

pub fn dispatch(command: CollectionsCmd, client: &BuzzClient) -> Result<(), CliError> {
    let scope = scope_for_client(client)?;
    let mut store =
        CollectionsStore::open(collections_db_path().map_err(map_error)?).map_err(map_error)?;

    match command {
        CollectionsCmd::Create {
            name,
            description,
            icon,
        } => print_json(&store.create_collection(
            &scope,
            &name,
            description.as_deref(),
            icon.as_deref(),
        )?),
        CollectionsCmd::Ls => print_json(&store.list_collections(&scope)?),
        CollectionsCmd::Get { collection } => {
            print_json(&store.get_collection(&scope, parse_uuid(&collection, "collection")?)?)
        }
        CollectionsCmd::SetIcon { collection, icon } => print_json(&store.set_collection_icon(
            &scope,
            parse_uuid(&collection, "collection")?,
            Some(&icon),
        )?),
        CollectionsCmd::ClearIcon { collection } => print_json(&store.set_collection_icon(
            &scope,
            parse_uuid(&collection, "collection")?,
            None,
        )?),
        CollectionsCmd::Rename { collection, name } => print_json(&store.set_collection_name(
            &scope,
            parse_uuid(&collection, "collection")?,
            &name,
        )?),
        CollectionsCmd::Rm { collection } => {
            let collection_id = parse_uuid(&collection, "collection")?;
            store.delete_collection(&scope, collection_id)?;
            print_json(&serde_json::json!({
                "deleted": true,
                "collection_id": collection_id,
            }))
        }
        CollectionsCmd::Add {
            collection,
            reference,
        } => {
            let collection_id = parse_uuid(&collection, "collection")?;
            let (reference, label) = reference.into_reference()?;
            print_json(&store.add_member(&scope, collection_id, &reference, label.as_deref())?)
        }
        CollectionsCmd::Remove { collection, member } => {
            let collection_id = parse_uuid(&collection, "collection")?;
            let member_id = parse_uuid(&member, "member")?;
            store.remove_member(&scope, collection_id, member_id)?;
            print_json(&serde_json::json!({
                "removed": true,
                "collection_id": collection_id,
                "member_id": member_id,
            }))
        }
    }
}

impl CollectionReferenceCmd {
    fn into_reference(self) -> Result<(CollectionReference, Option<String>), CliError> {
        let (reference, label) = match self {
            Self::Channel { channel, label } => (CollectionReference::channel(&channel), label),
            Self::Repository { repo, label } => (CollectionReference::repository(&repo), label),
            Self::Task { event, repo, label } => (CollectionReference::task(&event, &repo), label),
            Self::Thread {
                channel,
                event,
                label,
            } => (CollectionReference::thread(&channel, &event), label),
            Self::Message {
                channel,
                event,
                label,
            } => (CollectionReference::message(&channel, &event), label),
            Self::Note { coordinate, label } => (CollectionReference::note(&coordinate), label),
            Self::External { url, label } => (CollectionReference::external(&url), label),
        };
        Ok((reference.map_err(map_error)?, label))
    }
}

fn scope_for_client(client: &BuzzClient) -> Result<CollectionScope, CliError> {
    let owner_pubkey = client
        .auth_tag_owner_hex()
        .unwrap_or_else(|| client.keys().public_key().to_hex());
    CollectionScope::new(client.relay_url(), &owner_pubkey).map_err(map_error)
}

fn parse_uuid(value: &str, field: &str) -> Result<Uuid, CliError> {
    Uuid::parse_str(value).map_err(|_| CliError::Usage(format!("invalid {field} UUID: {value}")))
}

fn print_json(value: &impl serde::Serialize) -> Result<(), CliError> {
    println!(
        "{}",
        serde_json::to_string(value).map_err(|error| CliError::Other(format!(
            "failed to serialize Collections output: {error}"
        )))?
    );
    Ok(())
}

fn map_error(error: CollectionsError) -> CliError {
    match error {
        CollectionsError::Validation(message) => CliError::Usage(message),
        CollectionsError::NotFound(message) => CliError::NotFound(message),
        other => CliError::Other(other.to_string()),
    }
}

impl From<CollectionsError> for CliError {
    fn from(error: CollectionsError) -> Self {
        map_error(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: CollectionsCmd,
    }

    #[test]
    fn parses_collection_ids_strictly() {
        assert!(parse_uuid("not-a-uuid", "collection").is_err());
        assert!(parse_uuid("9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50", "collection").is_ok());
    }

    #[test]
    fn parses_create_and_icon_management_commands() {
        let create =
            TestCli::try_parse_from(["test", "create", "--name", "Bird Voice", "--icon", "🐦"])
                .expect("create command");
        assert!(matches!(
            create.command,
            CollectionsCmd::Create {
                icon: Some(ref icon),
                ..
            } if icon == "🐦"
        ));

        let set = TestCli::try_parse_from([
            "test",
            "set-icon",
            "--collection",
            "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
            "--icon",
            "🎧",
        ])
        .expect("set icon command");
        assert!(matches!(set.command, CollectionsCmd::SetIcon { .. }));

        let clear = TestCli::try_parse_from([
            "test",
            "clear-icon",
            "--collection",
            "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
        ])
        .expect("clear icon command");
        assert!(matches!(clear.command, CollectionsCmd::ClearIcon { .. }));

        let rename = TestCli::try_parse_from([
            "test",
            "rename",
            "--collection",
            "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
            "--name",
            "Berd Voice",
        ])
        .expect("rename command");
        assert!(matches!(
            rename.command,
            CollectionsCmd::Rename { ref name, .. } if name == "Berd Voice"
        ));
    }
}

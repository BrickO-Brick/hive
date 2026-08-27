use std::path::PathBuf;

use buzz_collections_pkg::{
    collections_db_path_for_app_data_dir, Collection, CollectionMember, CollectionReference,
    CollectionScope, CollectionWithMembers, CollectionsError, CollectionsStore,
};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

mod calendar;

pub use calendar::*;

#[derive(Debug, Deserialize)]
pub struct CreateCollectionInput {
    pub relay_url: String,
    pub owner_pubkey: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetCollectionIconInput {
    pub relay_url: String,
    pub owner_pubkey: String,
    pub collection_id: Uuid,
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetCollectionNameInput {
    pub relay_url: String,
    pub owner_pubkey: String,
    pub collection_id: Uuid,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct AddCollectionMemberInput {
    pub relay_url: String,
    pub owner_pubkey: String,
    pub collection_id: Uuid,
    pub reference: CollectionReference,
    pub label: Option<String>,
}

#[tauri::command]
pub async fn list_collections(
    relay_url: String,
    owner_pubkey: String,
    app: AppHandle,
) -> Result<Vec<Collection>, String> {
    let path = database_path(&app)?;
    let scope = CollectionScope::new(&relay_url, &owner_pubkey).map_err(render_error)?;
    with_store(path, move |store| store.list_collections(&scope)).await
}

#[tauri::command]
pub async fn get_collection(
    relay_url: String,
    owner_pubkey: String,
    id: String,
    app: AppHandle,
) -> Result<CollectionWithMembers, String> {
    let path = database_path(&app)?;
    let scope = CollectionScope::new(&relay_url, &owner_pubkey).map_err(render_error)?;
    let id = parse_uuid(&id, "collection")?;
    with_store(path, move |store| store.get_collection(&scope, id)).await
}

#[tauri::command]
pub async fn create_collection(
    input: CreateCollectionInput,
    app: AppHandle,
) -> Result<Collection, String> {
    let path = database_path(&app)?;
    let scope =
        CollectionScope::new(&input.relay_url, &input.owner_pubkey).map_err(render_error)?;
    with_store(path, move |store| {
        store.create_collection(
            &scope,
            &input.name,
            input.description.as_deref(),
            input.icon.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn set_collection_icon(
    input: SetCollectionIconInput,
    app: AppHandle,
) -> Result<Collection, String> {
    let path = database_path(&app)?;
    let scope =
        CollectionScope::new(&input.relay_url, &input.owner_pubkey).map_err(render_error)?;
    with_store(path, move |store| {
        store.set_collection_icon(&scope, input.collection_id, input.icon.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn set_collection_name(
    input: SetCollectionNameInput,
    app: AppHandle,
) -> Result<Collection, String> {
    let path = database_path(&app)?;
    let scope =
        CollectionScope::new(&input.relay_url, &input.owner_pubkey).map_err(render_error)?;
    with_store(path, move |store| {
        store.set_collection_name(&scope, input.collection_id, &input.name)
    })
    .await
}

#[tauri::command]
pub async fn delete_collection(
    relay_url: String,
    owner_pubkey: String,
    id: String,
    app: AppHandle,
) -> Result<(), String> {
    let path = database_path(&app)?;
    let scope = CollectionScope::new(&relay_url, &owner_pubkey).map_err(render_error)?;
    let id = parse_uuid(&id, "collection")?;
    with_store(path, move |store| store.delete_collection(&scope, id)).await
}

#[tauri::command]
pub async fn add_collection_member(
    input: AddCollectionMemberInput,
    app: AppHandle,
) -> Result<CollectionMember, String> {
    let path = database_path(&app)?;
    let scope =
        CollectionScope::new(&input.relay_url, &input.owner_pubkey).map_err(render_error)?;
    with_store(path, move |store| {
        store.add_member(
            &scope,
            input.collection_id,
            &input.reference,
            input.label.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn remove_collection_member(
    relay_url: String,
    owner_pubkey: String,
    collection_id: String,
    member_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let path = database_path(&app)?;
    let scope = CollectionScope::new(&relay_url, &owner_pubkey).map_err(render_error)?;
    let collection_id = parse_uuid(&collection_id, "collection")?;
    let member_id = parse_uuid(&member_id, "member")?;
    with_store(path, move |store| {
        store.remove_member(&scope, collection_id, member_id)
    })
    .await
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    collections_db_path_for_app_data_dir(&app_data_dir).map_err(render_error)
}

async fn with_store<T, F>(path: PathBuf, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut CollectionsStore) -> Result<T, CollectionsError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut store = CollectionsStore::open(path)?;
        operation(&mut store)
    })
    .await
    .map_err(|error| format!("collections task failed: {error}"))?
    .map_err(render_error)
}

fn parse_uuid(value: &str, field: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| format!("invalid {field} UUID: {value}"))
}

fn render_error(error: CollectionsError) -> String {
    error.to_string()
}

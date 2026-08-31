mod ipc;
mod manifest;
mod path_security;
mod protocol;
mod storage;

#[cfg(test)]
mod tests;

use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use manifest::ValidatedManifest;
use storage::{
    active_snapshot, clear_committed_updates, commit_snapshot, pending_updates, prepare_snapshot,
    project_source_location, prune_revisions, record_pending_update, record_source_binding,
    snapshot_for_revision, validate_widget_id, ProjectBinding, ProjectCanvasSourceLocation,
};

const MAX_ACTIVE_LOADS: usize = 64;

#[derive(Clone)]
pub(crate) struct ProjectCanvasRuntime {
    root: Option<PathBuf>,
    loads: Arc<Mutex<HashMap<String, ActiveLoad>>>,
    activation_lock: Arc<Mutex<()>>,
}

impl Default for ProjectCanvasRuntime {
    fn default() -> Self {
        Self {
            // Resolve the nest lazily: setup selects `.buzz` or `.buzz-dev`
            // after managed state is constructed.
            root: None,
            loads: Arc::new(Mutex::new(HashMap::new())),
            activation_lock: Arc::new(Mutex::new(())),
        }
    }
}

impl ProjectCanvasRuntime {
    #[cfg(test)]
    fn with_root(root: PathBuf) -> Self {
        Self {
            root: Some(root),
            loads: Arc::new(Mutex::new(HashMap::new())),
            activation_lock: Arc::new(Mutex::new(())),
        }
    }

    fn root(&self) -> Result<PathBuf, String> {
        self.root
            .clone()
            .or_else(|| crate::managed_agents::nest_dir().map(|root| root.join("CANVASES")))
            .ok_or_else(|| "cannot resolve the nest directory for project canvases".to_string())
    }

    fn get_or_activate(
        &self,
        request: ProjectCanvasPackageRequest,
        template: &std::path::Path,
    ) -> Result<ProjectCanvasPackageDescriptor, String> {
        let binding = ProjectBinding::parse(request)?;
        ensure_supported_platform()?;
        let _guard = self
            .activation_lock
            .lock()
            .map_err(|_| "project canvas activation lock is unavailable".to_string())?;

        let root = self.root()?;
        let snapshot = match active_snapshot(&root, &binding)? {
            Some(snapshot) => snapshot,
            None => prepare_snapshot(&root, &binding, Some(template))?,
        };
        let mut retained = self.referenced_revisions(&binding)?;
        retained.insert(snapshot.revision.clone());
        prune_revisions(&root, &binding, &retained)?;
        // The index is agent-facing discovery metadata, not runtime authority. A
        // malformed or manually edited index must not block a validated package.
        let _ = record_source_binding(&root, &binding);
        self.issue_load(binding, snapshot)
    }

    fn activate(
        &self,
        request: ProjectCanvasPackageRequest,
        template: &std::path::Path,
    ) -> Result<ProjectCanvasPackageDescriptor, String> {
        let binding = ProjectBinding::parse(request)?;
        ensure_supported_platform()?;
        let _guard = self
            .activation_lock
            .lock()
            .map_err(|_| "project canvas activation lock is unavailable".to_string())?;
        let root = self.root()?;
        let snapshot = prepare_snapshot(&root, &binding, Some(template))?;
        let mut retained = self.referenced_revisions(&binding)?;
        retained.insert(snapshot.revision.clone());
        prune_revisions(&root, &binding, &retained)?;
        let _ = record_source_binding(&root, &binding);
        self.issue_load(binding, snapshot)
    }

    fn commit(&self, load_id: &str) -> Result<(), String> {
        let load = self
            .load(load_id)?
            .ok_or_else(|| "project canvas load not found".to_string())?;
        let _guard = self
            .activation_lock
            .lock()
            .map_err(|_| "project canvas activation lock is unavailable".to_string())?;
        let root = self.root()?;
        commit_snapshot(&root, &load.binding, &load.revision)?;
        clear_committed_updates(&root, &load.binding, &load.revision)?;
        let retained = self.referenced_revisions(&load.binding)?;
        prune_revisions(&root, &load.binding, &retained)
    }

    fn accept_agent_update(
        &self,
        request: ProjectCanvasAgentUpdateRequest,
    ) -> Result<ProjectCanvasUpdateAccepted, String> {
        request.validate()?;
        let binding = ProjectBinding::parse(ProjectCanvasPackageRequest {
            community_id: request.community_id.clone(),
            project_id: request.project_id.clone(),
        })?;
        ensure_supported_platform()?;
        let _guard = self
            .activation_lock
            .lock()
            .map_err(|_| "project canvas activation lock is unavailable".to_string())?;
        let root = self.root()?;
        let snapshot = prepare_snapshot(&root, &binding, None)?;
        validate_widget_in_data(&snapshot.data, &request.widget_id)?;
        record_pending_update(
            &root,
            &binding,
            request.change,
            &request.notification_id,
            &request.widget_id,
            &snapshot.revision,
        )?;
        let retained = self.referenced_revisions(&binding)?;
        prune_revisions(&root, &binding, &retained)?;
        Ok(ProjectCanvasUpdateAccepted {
            change: request.change,
            community_id: request.community_id,
            notification_id: request.notification_id,
            project_id: request.project_id,
            revision: snapshot.revision,
            widget_id: request.widget_id,
        })
    }

    fn updates(
        &self,
        request: ProjectCanvasPackageRequest,
    ) -> Result<ProjectCanvasPendingUpdates, String> {
        let binding = ProjectBinding::parse(request)?;
        ensure_supported_platform()?;
        let _guard = self
            .activation_lock
            .lock()
            .map_err(|_| "project canvas activation lock is unavailable".to_string())?;
        let root = self.root()?;
        let updates = pending_updates(&root, &binding)?;
        let presentation = match updates.presentation {
            Some(update) => {
                let snapshot = snapshot_for_revision(&root, &binding, &update.revision)?;
                Some(ProjectCanvasPendingPresentation {
                    notification_id: update.notification_id,
                    package: self.issue_load(binding.clone(), snapshot)?,
                    widget_id: update.widget_id,
                })
            }
            None => None,
        };
        let data = match updates.data {
            Some(update) => {
                let snapshot = snapshot_for_revision(&root, &binding, &update.revision)?;
                Some(ProjectCanvasPendingData {
                    data: snapshot.data,
                    notification_id: update.notification_id,
                    revision: update.revision,
                    widget_id: update.widget_id,
                })
            }
            None => None,
        };
        Ok(ProjectCanvasPendingUpdates { data, presentation })
    }

    fn source_location(
        &self,
        request: ProjectCanvasPackageRequest,
    ) -> Result<ProjectCanvasSourceLocation, String> {
        let binding = ProjectBinding::parse(request)?;
        ensure_supported_platform()?;
        let _guard = self
            .activation_lock
            .lock()
            .map_err(|_| "project canvas activation lock is unavailable".to_string())?;
        let root = self.root()?;
        let location = project_source_location(&root, &binding)?;
        let _ = record_source_binding(&root, &binding);
        Ok(location)
    }

    fn issue_load(
        &self,
        binding: ProjectBinding,
        snapshot: storage::ValidatedSnapshot,
    ) -> Result<ProjectCanvasPackageDescriptor, String> {
        let load_id = uuid::Uuid::new_v4().simple().to_string();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let manifest = snapshot.manifest.clone();
        let data = snapshot.data.clone();
        let revision = snapshot.revision.clone();
        let scope = binding.scope();
        let load = ActiveLoad {
            binding,
            files: snapshot.files,
            nonce: nonce.clone(),
            scope,
            granted_capabilities: manifest.capabilities.clone(),
            manifest,
            revision: revision.clone(),
        };

        let mut loads = self
            .loads
            .lock()
            .map_err(|_| "project canvas load registry is unavailable".to_string())?;
        if loads.len() >= MAX_ACTIVE_LOADS {
            if let Some(oldest) = loads.keys().next().cloned() {
                loads.remove(&oldest);
            }
        }
        loads.insert(load_id.clone(), load);

        Ok(ProjectCanvasPackageDescriptor {
            url: protocol_url(&load_id),
            load_id,
            revision,
            nonce,
            capabilities: snapshot.manifest.capabilities,
            data,
        })
    }

    fn load(&self, load_id: &str) -> Result<Option<ActiveLoad>, String> {
        let loads = self
            .loads
            .lock()
            .map_err(|_| "project canvas load registry is unavailable".to_string())?;
        let load = loads.get(load_id).cloned();
        if let Some(load) = &load {
            if !load.scope.is_valid() || load.granted_capabilities != load.manifest.capabilities {
                return Err("project canvas load binding is invalid".to_string());
            }
        }
        Ok(load)
    }

    fn referenced_revisions(&self, binding: &ProjectBinding) -> Result<BTreeSet<String>, String> {
        let loads = self
            .loads
            .lock()
            .map_err(|_| "project canvas load registry is unavailable".to_string())?;
        Ok(loads
            .values()
            .filter(|load| load.binding.matches(binding))
            .map(|load| load.revision.clone())
            .collect())
    }

    fn release(&self, load_id: &str) -> Result<(), String> {
        let parsed = uuid::Uuid::parse_str(load_id)
            .map_err(|_| "invalid project canvas load id".to_string())?;
        let key = parsed.simple().to_string();
        let mut loads = self
            .loads
            .lock()
            .map_err(|_| "project canvas load registry is unavailable".to_string())?;
        loads.remove(&key);
        Ok(())
    }
}

#[derive(Clone)]
struct ActiveLoad {
    binding: ProjectBinding,
    files: Arc<std::collections::BTreeMap<String, Vec<u8>>>,
    nonce: String,
    scope: storage::CanvasScope,
    granted_capabilities: Vec<String>,
    manifest: ValidatedManifest,
    revision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectCanvasPackageRequest {
    community_id: String,
    project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectCanvasPackageDescriptor {
    load_id: String,
    url: String,
    revision: String,
    nonce: String,
    capabilities: Vec<String>,
    data: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProjectCanvasUpdateChange {
    Presentation,
    Data,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectCanvasAgentUpdateRequest {
    format: String,
    version: u32,
    notification_id: String,
    community_id: String,
    project_id: String,
    widget_id: String,
    change: ProjectCanvasUpdateChange,
}

impl ProjectCanvasAgentUpdateRequest {
    fn validate(&self) -> Result<(), String> {
        if self.format != ipc::UPDATE_FORMAT || self.version != ipc::UPDATE_VERSION {
            return Err("unsupported project canvas update request".to_string());
        }
        let parsed = uuid::Uuid::parse_str(&self.notification_id)
            .map_err(|_| "invalid project canvas update notification id".to_string())?;
        if parsed.simple().to_string() != self.notification_id {
            return Err("invalid project canvas update notification id".to_string());
        }
        validate_widget_id(&self.widget_id)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCanvasUpdateAccepted {
    change: ProjectCanvasUpdateChange,
    community_id: String,
    notification_id: String,
    project_id: String,
    revision: String,
    widget_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectCanvasPendingUpdates {
    data: Option<ProjectCanvasPendingData>,
    presentation: Option<ProjectCanvasPendingPresentation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCanvasPendingData {
    data: serde_json::Value,
    notification_id: String,
    revision: String,
    widget_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCanvasPendingPresentation {
    notification_id: String,
    package: ProjectCanvasPackageDescriptor,
    widget_id: String,
}

#[tauri::command]
pub(crate) async fn get_project_canvas_package(
    request: ProjectCanvasPackageRequest,
    app: AppHandle,
    runtime: State<'_, ProjectCanvasRuntime>,
) -> Result<ProjectCanvasPackageDescriptor, String> {
    let template = template_path(&app)?;
    let runtime = runtime.inner().clone();
    run_blocking(move || runtime.get_or_activate(request, &template)).await
}

#[tauri::command]
pub(crate) async fn get_project_canvas_updates(
    request: ProjectCanvasPackageRequest,
    runtime: State<'_, ProjectCanvasRuntime>,
) -> Result<ProjectCanvasPendingUpdates, String> {
    let runtime = runtime.inner().clone();
    run_blocking(move || runtime.updates(request)).await
}

#[tauri::command]
pub(crate) async fn activate_project_canvas_package(
    request: ProjectCanvasPackageRequest,
    app: AppHandle,
    runtime: State<'_, ProjectCanvasRuntime>,
) -> Result<ProjectCanvasPackageDescriptor, String> {
    let template = template_path(&app)?;
    let runtime = runtime.inner().clone();
    run_blocking(move || runtime.activate(request, &template)).await
}

#[tauri::command]
pub(crate) fn release_project_canvas_package(
    load_id: String,
    runtime: State<'_, ProjectCanvasRuntime>,
) -> Result<(), String> {
    runtime.release(&load_id)
}

#[tauri::command]
pub(crate) async fn commit_project_canvas_package(
    load_id: String,
    runtime: State<'_, ProjectCanvasRuntime>,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    run_blocking(move || runtime.commit(&load_id)).await
}

#[tauri::command]
pub(crate) async fn open_project_canvas_source(
    request: ProjectCanvasPackageRequest,
    app: AppHandle,
    runtime: State<'_, ProjectCanvasRuntime>,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    let location = run_blocking(move || runtime.source_location(request)).await?;
    app.opener()
        .open_path(&location.source_path, None::<&str>)
        .map_err(|error| format!("open project canvas source: {error}"))
}

#[tauri::command]
pub(crate) async fn get_project_canvas_source(
    request: ProjectCanvasPackageRequest,
    runtime: State<'_, ProjectCanvasRuntime>,
) -> Result<ProjectCanvasSourceLocation, String> {
    let runtime = runtime.inner().clone();
    run_blocking(move || runtime.source_location(request)).await
}

pub(crate) fn handle_request(
    app: &AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let runtime = app.state::<ProjectCanvasRuntime>();
    protocol::handle(&runtime, request)
}

pub(crate) fn start_agent_update_listener(app: AppHandle) -> Result<(), String> {
    ipc::start(app)
}

fn template_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|path| path.join("resources").join("project-canvas-template"))
        .map_err(|error| format!("resolve project canvas template: {error}"))
}

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("project canvas task failed: {error}"))?
}

fn protocol_url(load_id: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("http://buzz-canvas.localhost/{load_id}/")
    } else {
        format!("buzz-canvas://localhost/{load_id}/")
    }
}

fn ensure_supported_platform() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(
            "sandboxed project canvases are macOS-only until iframe IPC isolation is proven on this platform"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_widget_in_data(data: &serde_json::Value, widget_id: &str) -> Result<(), String> {
    let dashboards = data
        .get("dashboards")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "project canvas data must contain a dashboards object".to_string())?;
    let matches = dashboards
        .values()
        .filter_map(|dashboard| dashboard.get("widgets"))
        .filter_map(serde_json::Value::as_array)
        .flatten()
        .filter(|widget| widget.get("id").and_then(serde_json::Value::as_str) == Some(widget_id))
        .count();
    match matches {
        1 => Ok(()),
        0 => Err(format!(
            "widget id '{widget_id}' does not exist in the Canvas data"
        )),
        _ => Err(format!(
            "widget id '{widget_id}' must be unique across Canvas dashboards"
        )),
    }
}

pub(crate) fn allow_webview_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "buzz-canvas" => url.host_str() == Some("localhost"),
        "tauri" => url.host_str() == Some("localhost"),
        "http" if cfg!(debug_assertions) => {
            url.host_str() == Some("localhost") && url.port() == Some(1420)
        }
        _ => false,
    }
}

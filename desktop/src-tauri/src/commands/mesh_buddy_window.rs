//! Mesh Buddy — a small square companion window showing a smiley and how many
//! completion tokens this machine has served to the community mesh.
//!
//! The window is chrome only: it loads the static `mesh-buddy.html` page,
//! which polls the existing read-only `mesh_serving_usage` command. No new
//! trust surface — the page reads the same counters the Share compute card
//! already shows.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const MESH_BUDDY_LABEL: &str = "mesh-buddy";

/// Open (or re-focus) the Mesh Buddy window.
pub fn open_mesh_buddy_window_impl(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MESH_BUDDY_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        MESH_BUDDY_LABEL,
        WebviewUrl::App("mesh-buddy.html".into()),
    )
    .title("Mesh Buddy")
    .inner_size(320.0, 320.0)
    .resizable(false)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_mesh_buddy_window(app: tauri::AppHandle) -> Result<(), String> {
    open_mesh_buddy_window_impl(&app)
}

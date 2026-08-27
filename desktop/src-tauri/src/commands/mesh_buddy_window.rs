//! Mesh Buddy — a small square LED companion showing the shared-compute state
//! and how many completion tokens this machine has served to the community.
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
        eprintln!("buzz-mesh: existing Mesh Buddy window is running");
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        MESH_BUDDY_LABEL,
        WebviewUrl::App("mesh-buddy.html".into()),
    )
    .title("Mesh Buddy")
    .inner_size(320.0, 320.0)
    .min_inner_size(128.0, 128.0)
    .resizable(true)
    .always_on_top(true)
    .build()
    .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    eprintln!("buzz-mesh: Mesh Buddy window is running");
    Ok(())
}

/// Create or reveal Mesh Buddy on Tauri's native UI thread.
pub async fn open_mesh_buddy_window_on_main_thread(app: &tauri::AppHandle) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let main_thread_app = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(open_mesh_buddy_window_impl(&main_thread_app));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Mesh Buddy window creation was cancelled".to_string())?
}

#[tauri::command]
pub async fn open_mesh_buddy_window(app: tauri::AppHandle) -> Result<(), String> {
    open_mesh_buddy_window_on_main_thread(&app).await
}

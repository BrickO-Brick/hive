use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use tempfile::TempDir;

use super::{
    manifest::{validate_relative_path, MAX_DATA_BYTES, MAX_FILE_BYTES, MAX_PACKAGE_FILES},
    protocol,
    storage::{
        active_snapshot, commit_snapshot, prepare_snapshot, prune_revisions, record_source_binding,
        scan_package_for_test, validate_package_files, ProjectBinding, ValidatedPackage,
    },
    template::{bundled_template, template_files},
    ProjectCanvasAgentUpdateRequest, ProjectCanvasPackageRequest, ProjectCanvasRuntime,
    ProjectCanvasUpdateChange,
};

const OWNER: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn request() -> ProjectCanvasPackageRequest {
    ProjectCanvasPackageRequest {
        community_id: "community-a".to_string(),
        project_id: format!("30621:{OWNER}:my-project"),
    }
}

fn package_files(marker: &str) -> BTreeMap<String, Vec<u8>> {
    BTreeMap::from([
        (
            "manifest.json".to_string(),
            serde_json::to_vec_pretty(&serde_json::json!({
                "format": "buzz-project-canvas",
                "protocolVersion": 1,
                "scripts": ["widgets/chore-board.js", "canvas.js"],
                "styles": ["styles/canvas.css"],
                "data": "data/dashboards.json",
                "capabilities": [
                    "project.metadata.read",
                    "project.channels.read",
                    "project.reviews.read"
                ]
            }))
            .unwrap(),
        ),
        (
            "widgets/chore-board.js".to_string(),
            b"globalThis.renderChores = () => {};".to_vec(),
        ),
        (
            "canvas.js".to_string(),
            format!("globalThis.canvasMarker = {marker:?};").into_bytes(),
        ),
        (
            "styles/canvas.css".to_string(),
            b"body { margin: 0; }".to_vec(),
        ),
        (
            "data/dashboards.json".to_string(),
            serde_json::to_vec(&serde_json::json!({
                "marker": marker,
                "dashboards": {
                    "test": {
                        "widgets": [{
                            "id": "chore-board",
                            "data": { "marker": marker }
                        }]
                    }
                }
            }))
            .unwrap(),
        ),
        ("assets/pixel.png".to_string(), vec![137, 80, 78, 71]),
    ])
}

fn write_package(root: &Path, marker: &str) {
    write_package_files(root, &package_files(marker));
}

fn write_package_files(root: &Path, files: &BTreeMap<String, Vec<u8>>) {
    for (relative, bytes) in files {
        let destination = root.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(destination, bytes).unwrap();
    }
}

fn template_package(marker: &str) -> ValidatedPackage {
    validate_package_files(package_files(marker)).unwrap()
}

fn source_root(temp: &TempDir, binding: &ProjectBinding) -> std::path::PathBuf {
    let root = temp.path().join("CANVASES");
    fs::create_dir_all(&root).unwrap();
    let canonical = root.canonicalize().unwrap();
    binding.project_root_for_test(&canonical)
}

#[test]
fn activation_is_content_addressed_and_preserves_last_known_good() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "first");

    let first = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap();
    assert_eq!(first.revision.len(), 64);
    assert_eq!(first.data["marker"], "first");
    commit_snapshot(&temp.path().join("CANVASES"), &binding, &first.revision).unwrap();

    fs::write(source.join("data/dashboards.json"), b"not json").unwrap();
    assert!(prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).is_err());
    let active = active_snapshot(&temp.path().join("CANVASES"), &binding)
        .unwrap()
        .unwrap();
    assert_eq!(active.revision, first.revision);
    assert_eq!(active.data["marker"], "first");
}

#[test]
fn candidate_revision_is_not_active_until_render_commit() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "first");
    let first = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap();
    commit_snapshot(&temp.path().join("CANVASES"), &binding, &first.revision).unwrap();

    fs::write(
        source.join("canvas.js"),
        "globalThis.canvasMarker = 'candidate';",
    )
    .unwrap();
    let candidate = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap();
    assert_ne!(candidate.revision, first.revision);
    assert_eq!(
        active_snapshot(&temp.path().join("CANVASES"), &binding)
            .unwrap()
            .unwrap()
            .revision,
        first.revision
    );

    commit_snapshot(&temp.path().join("CANVASES"), &binding, &candidate.revision).unwrap();
    assert_eq!(
        active_snapshot(&temp.path().join("CANVASES"), &binding)
            .unwrap()
            .unwrap()
            .revision,
        candidate.revision
    );
}

#[test]
fn agent_updates_are_durable_delineated_and_commit_only_matching_state() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("CANVASES");
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "active");
    let active = prepare_snapshot(&root, &binding, None).unwrap();
    commit_snapshot(&root, &binding, &active.revision).unwrap();
    let runtime = ProjectCanvasRuntime::with_root(root.clone());

    write_package(&source, "data-one");
    runtime
        .accept_agent_update(ProjectCanvasAgentUpdateRequest {
            change: ProjectCanvasUpdateChange::Data,
            community_id: request().community_id,
            format: "buzz-project-canvas-update".to_string(),
            notification_id: "11111111111141118111111111111111".to_string(),
            project_id: request().project_id,
            version: 1,
            widget_id: "chore-board".to_string(),
        })
        .unwrap();
    let first_updates = runtime.updates(request()).unwrap();
    assert!(first_updates.presentation.is_none());
    assert_eq!(first_updates.data.unwrap().data["marker"], "data-one");
    assert_eq!(
        active_snapshot(&root, &binding).unwrap().unwrap().data["marker"],
        "active"
    );

    write_package(&source, "presentation");
    runtime
        .accept_agent_update(ProjectCanvasAgentUpdateRequest {
            change: ProjectCanvasUpdateChange::Presentation,
            community_id: request().community_id,
            format: "buzz-project-canvas-update".to_string(),
            notification_id: "22222222222242228222222222222222".to_string(),
            project_id: request().project_id,
            version: 1,
            widget_id: "chore-board".to_string(),
        })
        .unwrap();
    let presentation_updates = runtime.updates(request()).unwrap();
    assert!(presentation_updates.data.is_none());
    let presentation = presentation_updates.presentation.unwrap().package;

    write_package(&source, "data-newer");
    runtime
        .accept_agent_update(ProjectCanvasAgentUpdateRequest {
            change: ProjectCanvasUpdateChange::Data,
            community_id: request().community_id,
            format: "buzz-project-canvas-update".to_string(),
            notification_id: "33333333333343338333333333333333".to_string(),
            project_id: request().project_id,
            version: 1,
            widget_id: "chore-board".to_string(),
        })
        .unwrap();

    runtime.commit(&presentation.load_id).unwrap();
    let remaining = runtime.updates(request()).unwrap();
    assert!(remaining.presentation.is_none());
    assert_eq!(remaining.data.unwrap().data["marker"], "data-newer");
    assert_eq!(
        active_snapshot(&root, &binding).unwrap().unwrap().data["marker"],
        "presentation"
    );
}

#[test]
fn package_reloads_after_runtime_metadata_is_created() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("CANVASES");
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "reloadable");

    let first = prepare_snapshot(&root, &binding, None).unwrap();
    commit_snapshot(&root, &binding, &first.revision).unwrap();
    let second = prepare_snapshot(&root, &binding, None).unwrap();

    assert_eq!(second.revision, first.revision);
    assert_eq!(second.data["marker"], "reloadable");
    assert!(!source.join(".runtime").exists());
    assert!(binding.runtime_root_for_test(&root).is_dir());
}

#[test]
fn revision_retention_keeps_active_live_and_recent_snapshots() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("CANVASES");
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    let mut revisions = Vec::new();
    for index in 0..8 {
        write_package(&source, &format!("revision-{index}"));
        let snapshot = prepare_snapshot(&root, &binding, None).unwrap();
        revisions.push(snapshot.revision);
    }
    commit_snapshot(&root, &binding, &revisions[0]).unwrap();
    let retained = BTreeSet::from([revisions[3].clone()]);

    prune_revisions(&root, &binding, &retained).unwrap();

    let revisions_root = binding.runtime_root_for_test(&root).join("revisions");
    let remaining = fs::read_dir(revisions_root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<BTreeSet<_>>();
    assert!(remaining.len() <= 4);
    assert!(remaining.contains(&revisions[0]));
    assert!(remaining.contains(&revisions[3]));
}

#[test]
fn first_activation_seeds_the_validated_template() {
    let temp = TempDir::new().unwrap();
    let template = template_package("seeded");
    let binding = ProjectBinding::parse(request()).unwrap();

    let snapshot =
        prepare_snapshot(&temp.path().join("CANVASES"), &binding, Some(&template)).unwrap();

    assert_eq!(snapshot.data["marker"], "seeded");
    let source = source_root(&temp, &binding);
    assert!(source.join("manifest.json").is_file());
    let parent = source.parent().unwrap();
    assert!(!fs::read_dir(parent)
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().starts_with(".seed-")));
}

// Binds the embedded seed bytes to the loader, so a template edit that fails
// manifest validation surfaces here instead of on the first canvas load.
#[test]
fn bundled_template_seeds_a_valid_snapshot() {
    let temp = TempDir::new().unwrap();
    let template = bundled_template().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();

    let snapshot =
        prepare_snapshot(&temp.path().join("CANVASES"), &binding, Some(&template)).unwrap();

    assert!(snapshot.data["dashboards"].is_object());
}

// `include_dir!` expands to one `include_bytes!` per file, so a file added to
// or removed from the template only reaches the binary if the build script's
// `rerun-if-changed` fired. Compare the embedded key set against the tree on
// disk to catch a stale or partial embed.
#[test]
fn bundled_template_contains_the_expected_tree() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("project-canvas-template");
    let mut expected = BTreeSet::new();
    collect_relative_paths(&root, &root, &mut expected);

    let embedded = template_files()
        .unwrap()
        .into_keys()
        .collect::<BTreeSet<_>>();

    assert_eq!(embedded, expected);
}

fn collect_relative_paths(root: &Path, directory: &Path, paths: &mut BTreeSet<String>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_relative_paths(root, &path, paths);
            continue;
        }
        if path.file_name() == Some(std::ffi::OsStr::new(".DS_Store")) {
            continue;
        }
        paths.insert(
            path.strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace(std::path::MAIN_SEPARATOR, "/"),
        );
    }
}

// The embedded template must clear the same path gate as any package read off
// disk — it is seeded through the identical validation, not a weaker one.
#[test]
fn bundled_template_paths_are_package_safe() {
    for path in template_files().unwrap().keys() {
        assert_eq!(
            validate_relative_path(path).as_deref(),
            Ok(path.as_str()),
            "{path}"
        );
        assert!(!Path::new(path).is_absolute(), "{path}");
        assert!(!path.contains('\\'), "{path}");
        assert!(!path.split('/').any(|segment| segment == ".."), "{path}");
    }
}

// The missing-directory arm has to run before the symlink inspection, or an
// absent package dies inside `symlink_metadata` with an unnamed `os error 2` —
// exactly the failure that made a vanished template unreadable to debug.
#[test]
fn missing_package_directory_names_the_path() {
    let temp = TempDir::new().unwrap();
    let absent = temp.path().join("absent-revision");

    let error = scan_package_for_test(temp.path(), &absent).unwrap_err();

    assert!(error.contains("does not exist"), "{error}");
    assert!(error.contains("absent-revision"), "{error}");
}

// A symlinked package root is refused even when it points at a valid package:
// the existence check reads non-following metadata, so it cannot mask the
// symlink arm behind a `Path::is_dir()` that follows links.
#[cfg(unix)]
#[test]
fn package_root_symlink_is_rejected() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let real = temp.path().join("real-package");
    write_package(&real, "root-symlink");
    let linked = temp.path().join("linked-package");
    symlink(&real, &linked).unwrap();

    assert!(scan_package_for_test(temp.path(), &real).is_ok());
    let error = scan_package_for_test(temp.path(), &linked).unwrap_err();
    assert!(error.contains("cannot be symlinks"), "{error}");
}

#[test]
fn source_index_is_machine_readable_sorted_and_path_derived() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("CANVASES");
    let first = ProjectBinding::parse(request()).unwrap();
    let second = ProjectBinding::parse(ProjectCanvasPackageRequest {
        community_id: "community-b".to_string(),
        project_id: format!("30621:{OWNER}:another-project"),
    })
    .unwrap();
    write_package(&source_root(&temp, &first), "first-indexed");
    write_package(&source_root(&temp, &second), "second-indexed");

    let second_location = record_source_binding(&root, &second).unwrap();
    let first_location = record_source_binding(&root, &first).unwrap();
    record_source_binding(&root, &first).unwrap();

    let index: serde_json::Value =
        serde_json::from_slice(&fs::read(&first_location.index_path).unwrap()).unwrap();
    assert_eq!(index["format"], "buzz-project-canvas-index");
    assert_eq!(index["version"], 1);
    let entries = index["canvases"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["communityId"], "community-a");
    assert_eq!(entries[0]["sourcePath"], first_location.source_path);
    assert_eq!(entries[1]["communityId"], "community-b");
    assert_eq!(entries[1]["sourcePath"], second_location.source_path);

    let mut corrupt = index;
    corrupt["canvases"][0]["sourcePath"] = serde_json::json!("/tmp/outside-canvas");
    fs::write(
        &first_location.index_path,
        serde_json::to_vec(&corrupt).unwrap(),
    )
    .unwrap();
    let error = record_source_binding(&root, &first).unwrap_err();
    assert!(error.contains("mismatched source path"));
}

#[test]
fn malformed_source_index_does_not_block_a_valid_canvas_load() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("CANVASES");
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "load-with-corrupt-index");
    fs::write(root.join("index.json"), b"not json").unwrap();
    let runtime = ProjectCanvasRuntime::with_root(root);

    let descriptor = runtime.get_or_activate(request(), None).unwrap();

    assert_eq!(descriptor.data["marker"], "load-with-corrupt-index");
    assert!(runtime.source_location(request()).is_ok());
}

#[cfg(unix)]
#[test]
fn symlinked_source_index_is_rejected() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let root = temp.path().join("CANVASES");
    let binding = ProjectBinding::parse(request()).unwrap();
    write_package(&source_root(&temp, &binding), "indexed");
    let outside = temp.path().join("outside-index.json");
    fs::write(
        &outside,
        br#"{"format":"buzz-project-canvas-index","version":1,"canvases":[]}"#,
    )
    .unwrap();
    symlink(outside, root.join("index.json")).unwrap();

    assert!(record_source_binding(&root, &binding).is_err());
}

#[test]
fn package_data_limit_matches_the_host_descriptor_envelope() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "bounded-data");
    let overhead = r#"{"value":""}"#.len();
    let maximum = format!(r#"{{"value":"{}"}}"#, "x".repeat(MAX_DATA_BYTES - overhead));
    fs::write(source.join("data/dashboards.json"), &maximum).unwrap();
    assert_eq!(maximum.len(), MAX_DATA_BYTES);
    assert!(prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).is_ok());

    fs::write(source.join("data/dashboards.json"), format!("{maximum} ")).unwrap();
    let error = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap_err();
    assert!(error.contains("exceeds 256 KiB"));
}

#[test]
fn package_scan_stops_at_the_cumulative_byte_limit() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "bounded-package");
    for index in 0..4 {
        let file = fs::File::create(source.join(format!("assets/large-{index}.png"))).unwrap();
        file.set_len(MAX_FILE_BYTES as u64).unwrap();
    }

    let error = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap_err();
    assert!(error.contains("exceeds 32 MiB"));
}

#[test]
fn package_scan_bounds_empty_directory_entries() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "bounded-entries");
    for index in 0..MAX_PACKAGE_FILES {
        fs::create_dir(source.join(format!("assets/empty-{index}"))).unwrap();
    }

    let error = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap_err();
    assert!(error.contains("entries"));
}

#[test]
fn package_data_structure_limit_matches_the_host_parser() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "bounded-structure");
    let accepted = serde_json::Value::Array(vec![serde_json::Value::Null; 9_999]);
    fs::write(
        source.join("data/dashboards.json"),
        serde_json::to_vec(&accepted).unwrap(),
    )
    .unwrap();
    assert!(prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).is_ok());

    let rejected = serde_json::Value::Array(vec![serde_json::Value::Null; 10_000]);
    fs::write(
        source.join("data/dashboards.json"),
        serde_json::to_vec(&rejected).unwrap(),
    )
    .unwrap();
    let error = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap_err();
    assert!(error.contains("JSON structure limit"));

    let mut accepted_depth = serde_json::Value::Null;
    for _ in 0..32 {
        accepted_depth = serde_json::json!({ "nested": accepted_depth });
    }
    fs::write(
        source.join("data/dashboards.json"),
        serde_json::to_vec(&accepted_depth).unwrap(),
    )
    .unwrap();
    assert!(prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).is_ok());

    let rejected_depth = serde_json::json!({ "nested": accepted_depth });
    fs::write(
        source.join("data/dashboards.json"),
        serde_json::to_vec(&rejected_depth).unwrap(),
    )
    .unwrap();
    let error = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap_err();
    assert!(error.contains("JSON structure limit"));
}

#[test]
fn active_load_serves_its_validated_bytes_after_disk_mutation() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "immutable");
    let snapshot = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap();
    let revision = snapshot.revision.clone();
    let runtime = ProjectCanvasRuntime::with_root(temp.path().join("CANVASES"));
    let descriptor = runtime.issue_load(binding.clone(), snapshot).unwrap();

    let disk_entry = binding
        .runtime_root_for_test(&temp.path().join("CANVASES"))
        .join("revisions")
        .join(revision)
        .join("canvas.js");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&disk_entry, fs::Permissions::from_mode(0o644)).unwrap();
    }
    #[cfg(windows)]
    {
        let mut permissions = fs::metadata(&disk_entry).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&disk_entry, permissions).unwrap();
    }
    fs::write(&disk_entry, "globalThis.canvasMarker = 'tampered';").unwrap();

    let path = format!("/{}/package/canvas.js", descriptor.load_id);
    let (_, body) = protocol::route(&runtime, &path).unwrap();
    assert_eq!(
        String::from_utf8(body).unwrap(),
        "globalThis.canvasMarker = \"immutable\";"
    );

    runtime.release(&descriptor.load_id).unwrap();
    assert!(protocol::route(&runtime, &path).is_err());
}

#[test]
fn bootstrap_is_host_owned_and_loads_only_declared_scripts_after_connect() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "bootstrap");
    let snapshot = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap();
    let runtime = ProjectCanvasRuntime::with_root(temp.path().join("CANVASES"));
    let descriptor = runtime.issue_load(binding, snapshot).unwrap();

    let (_, shell) = protocol::route(&runtime, &format!("/{}/", descriptor.load_id)).unwrap();
    let shell = String::from_utf8(shell).unwrap();
    assert!(shell.contains("id=\"canvas-root\""));
    assert!(!shell.contains("canvasMarker"));

    let (_, bootstrap) = protocol::route(
        &runtime,
        &format!("/{}/__buzz/bootstrap.js", descriptor.load_id),
    )
    .unwrap();
    let bootstrap = String::from_utf8(bootstrap).unwrap();
    assert!(bootstrap.contains(&descriptor.nonce));
    assert!(bootstrap.contains("message.type !== \"host.connect\""));
    assert!(bootstrap.contains("widgets/chore%2Dboard%2Ejs"));
    assert!(bootstrap.contains("canvas%2Ejs"));
    assert!(bootstrap.contains("window, \"buzzCanvas\""));
    assert!(bootstrap.contains("packageBaseUrl"));
    assert!(bootstrap.contains("new URL(\"./package/\", location.href).href"));
    assert!(bootstrap.contains("sdk: {}"));
    assert!(!protocol::DOCUMENT_CSP.contains("'unsafe-inline'"));

    // The host SDK loads before any package resource so packages can use
    // window.buzzCanvas.sdk from their first statement.
    let scripts_list = bootstrap
        .split("const scripts = [")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap();
    assert!(scripts_list.starts_with("\"./__buzz/sdk.js\","));
    let styles_list = bootstrap
        .split("const styles = [")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap();
    assert!(styles_list.starts_with("\"./__buzz/sdk.css\","));
}

#[test]
fn host_sdk_routes_serve_the_bundled_sources() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "sdk");
    let snapshot = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap();
    let runtime = ProjectCanvasRuntime::with_root(temp.path().join("CANVASES"));
    let descriptor = runtime.issue_load(binding, snapshot).unwrap();

    let (content_type, sdk_js) =
        protocol::route(&runtime, &format!("/{}/__buzz/sdk.js", descriptor.load_id)).unwrap();
    assert_eq!(content_type, "text/javascript; charset=utf-8");
    let sdk_js = String::from_utf8(sdk_js).unwrap();
    assert!(sdk_js.contains("canvas.subscribe"));
    assert!(sdk_js.contains("host.subscriptionUpdate"));
    // The SDK must not start the port: the package entry owns port.start(),
    // and starting it early would drop host.init for later listeners.
    assert!(!sdk_js.contains("port.start()"));

    let (content_type, sdk_css) =
        protocol::route(&runtime, &format!("/{}/__buzz/sdk.css", descriptor.load_id)).unwrap();
    assert_eq!(content_type, "text/css; charset=utf-8");
    assert!(String::from_utf8(sdk_css)
        .unwrap()
        .contains("--buzz-background"));
}

#[test]
fn manifest_accepts_the_full_capability_set_and_rejects_unknown_ones() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "capabilities");
    let manifest_path = source.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    // Must accept every capability the desktop protocol schema recognizes.
    manifest["capabilities"] = serde_json::json!([
        "project.metadata.read",
        "project.channels.read",
        "project.reviews.read",
        "project.tasks.read",
        "project.people.read",
        "project.tasks.write",
        "app.open"
    ]);
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).is_ok());

    manifest["capabilities"] = serde_json::json!(["network"]);
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let error = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap_err();
    assert!(error.contains("unsupported project canvas capability"));
}

#[test]
fn invalid_or_undeclared_package_files_fail_closed() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "bad");
    fs::write(source.join("index.html"), "<script>bad()</script>").unwrap();

    let error = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap_err();
    assert!(error.contains("unsupported project canvas file type"));
}

#[test]
fn finder_metadata_does_not_break_package_reload() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "finder");
    fs::write(source.join(".DS_Store"), b"finder metadata").unwrap();

    assert!(prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).is_ok());
}

#[test]
fn manifest_paths_cannot_traverse_the_package() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "bad-path");
    let manifest = serde_json::json!({
        "format": "buzz-project-canvas",
        "protocolVersion": 1,
        "scripts": ["widgets/../escape.js", "canvas.js"],
        "styles": ["styles/canvas.css"],
        "data": "data/dashboards.json",
        "capabilities": []
    });
    fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();

    assert!(prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_storage_ancestor_is_rejected() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let root = temp.path().join("CANVASES");
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let project = binding.project_root_for_test(&root);
    let community = root.join(
        project
            .strip_prefix(&root)
            .unwrap()
            .components()
            .next()
            .unwrap(),
    );
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, &community).unwrap();

    let error = prepare_snapshot(&root, &binding, None).unwrap_err();
    assert!(error.contains("not a real directory"));
}

#[cfg(unix)]
#[test]
fn package_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "symlink");
    let outside = temp.path().join("outside.png");
    fs::write(&outside, "secret").unwrap();
    symlink(&outside, source.join("assets/leak.png")).unwrap();

    assert!(prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).is_err());
}

#[cfg(unix)]
#[test]
fn package_hard_links_are_rejected() {
    let temp = TempDir::new().unwrap();
    let binding = ProjectBinding::parse(request()).unwrap();
    let source = source_root(&temp, &binding);
    write_package(&source, "hard-link");
    let outside = temp.path().join("outside.png");
    fs::write(&outside, "secret").unwrap();
    fs::hard_link(&outside, source.join("assets/leak.png")).unwrap();

    let error = prepare_snapshot(&temp.path().join("CANVASES"), &binding, None).unwrap_err();
    assert!(error.contains("hard linked"));
}

#[test]
fn project_coordinate_and_community_are_validated_before_path_derivation() {
    let mut invalid = request();
    invalid.community_id = "../other".to_string();
    // Community values are hashed, so punctuation cannot become a path.
    assert!(ProjectBinding::parse(invalid).is_ok());

    let mut invalid = request();
    invalid.project_id = "30621:not-hex:project".to_string();
    assert!(ProjectBinding::parse(invalid).is_err());

    let mut invalid = request();
    invalid.project_id = format!("30621:{OWNER}:");
    assert!(ProjectBinding::parse(invalid).is_err());
}

#[test]
fn protocol_security_policy_has_no_network_or_tauri_ipc_source() {
    assert!(protocol::DOCUMENT_CSP.contains("connect-src 'none'"));
    assert!(protocol::DOCUMENT_CSP.contains("webrtc 'block'"));
    assert!(!protocol::DOCUMENT_CSP.contains(" ipc:"));
    assert!(!protocol::PERMISSIONS_POLICY.contains("camera=(*"));
    assert!(!protocol::PERMISSIONS_POLICY.contains("microphone=(*"));
}

#[test]
fn native_navigation_policy_blocks_external_document_navigation() {
    assert!(super::allow_webview_navigation(
        &"buzz-canvas://localhost/load/".parse().unwrap(),
        None
    ));
    assert!(super::allow_webview_navigation(
        &"tauri://localhost/".parse().unwrap(),
        None
    ));
    assert!(super::allow_webview_navigation(
        &"about:blank".parse().unwrap(),
        None
    ));
    assert!(!super::allow_webview_navigation(
        &"https://example.com/leak?snapshot=secret".parse().unwrap(),
        None
    ));
    assert!(!super::allow_webview_navigation(
        &"file:///tmp/secret".parse().unwrap(),
        None
    ));
}

// The dev server load is the webview's *initial* navigation, so a policy that
// does not recognise the configured origin opens a blank window. Every `just`
// desktop recipe derives a per-worktree Vite port, so the origin the app is
// launched on is never the `tauri.conf.json` default.
#[test]
fn native_navigation_policy_allows_the_configured_dev_server() {
    let dev_url: tauri::Url = "http://localhost:30164".parse().unwrap();

    assert!(super::allow_webview_navigation(
        &"http://localhost:30164/".parse().unwrap(),
        Some(&dev_url)
    ));
    assert!(super::allow_webview_navigation(
        &"http://localhost:30164/index.html".parse().unwrap(),
        Some(&dev_url)
    ));
}

#[test]
fn native_navigation_policy_blocks_other_localhost_origins() {
    let dev_url: tauri::Url = "http://localhost:30164".parse().unwrap();

    // Some other server on the loopback interface is not the frontend.
    assert!(!super::allow_webview_navigation(
        &"http://localhost:1420/".parse().unwrap(),
        Some(&dev_url)
    ));
    assert!(!super::allow_webview_navigation(
        &"http://127.0.0.1:30164/".parse().unwrap(),
        Some(&dev_url)
    ));
    // Release builds have no dev server, so plain http stays blocked.
    assert!(!super::allow_webview_navigation(
        &"http://localhost:30164/".parse().unwrap(),
        None
    ));
}

// `start` runs on the main thread from Tauri's `setup` hook, with no Tokio
// runtime in context. Registering the socket with the reactor there aborts the
// whole app on launch, so the handoff has to survive a plain sync caller.
#[cfg(unix)]
#[test]
fn agent_update_socket_serves_when_started_outside_the_async_runtime() {
    use std::{
        os::unix::net::{UnixListener as StdUnixListener, UnixStream as StdUnixStream},
        sync::mpsc,
        time::Duration,
    };

    let temp = TempDir::new().unwrap();
    let socket_path = temp.path().join("agent-updates.sock");
    let listener = StdUnixListener::bind(&socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();

    let (accepted, wait) = mpsc::channel();
    super::ipc::spawn_serving(listener, socket_path.clone(), move |listener| async move {
        if listener.accept().await.is_ok() {
            let _ = accepted.send(());
        }
    });

    let _client = StdUnixStream::connect(&socket_path).unwrap();
    wait.recv_timeout(Duration::from_secs(5))
        .expect("socket bound before the runtime handoff should still accept connections");
}

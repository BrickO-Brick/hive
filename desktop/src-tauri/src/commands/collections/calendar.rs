use std::{collections::HashSet, path::Path, process::Stdio, time::Duration};

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

const CALENDAR_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);
const CALENDAR_TOOL_TIMEOUT_SECS: &str = "15";
const DRIVE_PROCESS_TIMEOUT: Duration = Duration::from_secs(12);
const DRIVE_TOOL_TIMEOUT_SECS: &str = "10";
const CALENDAR_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_ACTIVITY_DOCUMENTS: usize = 16;
const MAX_CALENDAR_STDOUT_BYTES: usize = 1024 * 1024;
const MAX_CALENDAR_STDERR_BYTES: usize = 64 * 1024;
const CALENDAR_UNAVAILABLE: &str = "Optional Google Calendar discovery is unavailable";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionDiscoveredLink {
    pub url: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionCalendarActivity {
    pub action_type: String,
    pub timestamp: String,
    pub actor_display_name: Option<String>,
    pub actor_email: Option<String>,
    pub document_title: String,
    pub document_url: String,
    pub document_file_id: String,
    pub source_calendar_url: String,
    pub source_attachment_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionActivitySourceError {
    pub source_url: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionCalendarActivityResult {
    pub activities: Vec<CollectionCalendarActivity>,
    pub errors: Vec<CollectionActivitySourceError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DriveDocumentMetadata {
    file_id: String,
    title: String,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedDriveActivity {
    action_type: String,
    timestamp: String,
    actor_display_name: Option<String>,
    actor_email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CalendarToolResponse {
    #[serde(default)]
    result: Option<CalendarEventResult>,
    #[serde(default)]
    attachments: Vec<CalendarAttachment>,
}

#[derive(Debug, Deserialize)]
struct CalendarEventResult {
    #[serde(default)]
    attachments: Vec<CalendarAttachment>,
}

#[derive(Debug, Deserialize)]
struct CalendarAttachment {
    #[serde(rename = "fileUrl")]
    file_url: String,
    #[serde(default)]
    title: String,
}

/// Discover current document attachments for a linked Google Calendar event.
///
/// Collections keep the calendar event as the explicit membership edge. This
/// optional local resolver reads the user's already-connected Calendar account
/// and returns ephemeral children; it never writes those children to SQLite.
#[tauri::command]
pub async fn discover_collection_calendar_links(
    url: String,
) -> Result<Vec<CollectionDiscoveredLink>, String> {
    validate_google_calendar_event_url(&url)?;
    let sq_path = crate::managed_agents::resolve_command("sq")
        .ok_or_else(|| format!("{CALENDAR_UNAVAILABLE}: `sq` was not found on this device"))?;

    fetch_calendar_links(&sq_path, &url).await
}

/// Discover ephemeral edit and comment activity for Google Drive documents
/// attached to an explicit Google Calendar event.
#[tauri::command]
pub async fn discover_collection_calendar_activity(
    calendar_url: String,
    start_time: String,
    end_time: Option<String>,
) -> Result<CollectionCalendarActivityResult, String> {
    validate_google_calendar_event_url(&calendar_url)?;
    validate_activity_window(&start_time, end_time.as_deref())?;
    let sq_path = crate::managed_agents::resolve_command("sq").ok_or_else(|| {
        format!(
            "Optional Google Calendar activity discovery is unavailable for {calendar_url}: `sq` was not found on this device"
        )
    })?;

    tokio::time::timeout(
        CALENDAR_ACTIVITY_TIMEOUT,
        discover_calendar_activity(&sq_path, &calendar_url, &start_time, end_time.as_deref()),
    )
    .await
    .map_err(|_| {
        format!(
            "Optional Google Calendar activity discovery is unavailable for {calendar_url}: lookup timed out"
        )
    })?
}

async fn fetch_calendar_links(
    sq_path: &Path,
    url: &str,
) -> Result<Vec<CollectionDiscoveredLink>, String> {
    let args = [
        "agent-tools",
        "google-calendar",
        "get-calendar-event",
        "--event-id",
        url,
        "--calendar-id",
        "primary",
        "--output",
        "json",
        "--timeout",
        CALENDAR_TOOL_TIMEOUT_SECS,
    ];
    let stdout = run_sq_command(
        sq_path,
        &args,
        CALENDAR_DISCOVERY_TIMEOUT,
        CALENDAR_UNAVAILABLE,
    )
    .await?;
    parse_calendar_links(&stdout).map_err(|error| format!("{CALENDAR_UNAVAILABLE}: {error}"))
}

async fn discover_calendar_activity(
    sq_path: &Path,
    calendar_url: &str,
    start_time: &str,
    end_time: Option<&str>,
) -> Result<CollectionCalendarActivityResult, String> {
    let links = fetch_calendar_links(sq_path, calendar_url)
        .await
        .map_err(|error| {
            format!(
                "Optional Google Calendar activity discovery is unavailable for {calendar_url}: {error}"
            )
        })?;
    let mut documents = Vec::new();
    let mut seen_file_ids = HashSet::new();
    for link in links {
        let Some(file_id) = google_drive_file_id(&link.url) else {
            continue;
        };
        if seen_file_ids.insert(file_id.clone()) {
            documents.push((file_id, link.url, link.label));
        }
    }

    let mut result = CollectionCalendarActivityResult {
        activities: Vec::new(),
        errors: Vec::new(),
    };
    if documents.len() > MAX_ACTIVITY_DOCUMENTS {
        result.errors.push(CollectionActivitySourceError {
            source_url: calendar_url.to_string(),
            message: format!(
                "Only the first {MAX_ACTIVITY_DOCUMENTS} attached Drive documents were checked"
            ),
        });
        documents.truncate(MAX_ACTIVITY_DOCUMENTS);
    }

    for (file_id, attachment_url, attachment_label) in documents {
        let metadata = match fetch_drive_metadata(sq_path, &file_id).await {
            Ok(metadata) => metadata,
            Err(message) => {
                result.errors.push(CollectionActivitySourceError {
                    source_url: attachment_url,
                    message: format!("{attachment_label} ({file_id}): {message}"),
                });
                continue;
            }
        };
        let activities = match fetch_drive_activity(sq_path, &file_id, start_time, end_time).await {
            Ok(activities) => activities,
            Err(message) => {
                result.errors.push(CollectionActivitySourceError {
                    source_url: attachment_url,
                    message: format!("{} ({file_id}): {message}", metadata.title),
                });
                continue;
            }
        };
        result
            .activities
            .extend(
                activities
                    .into_iter()
                    .map(|activity| CollectionCalendarActivity {
                        action_type: activity.action_type,
                        timestamp: activity.timestamp,
                        actor_display_name: activity.actor_display_name,
                        actor_email: activity.actor_email,
                        document_title: metadata.title.clone(),
                        document_url: metadata.url.clone(),
                        document_file_id: metadata.file_id.clone(),
                        source_calendar_url: calendar_url.to_string(),
                        source_attachment_url: attachment_url.clone(),
                    }),
            );
    }

    result.activities.sort_by(|left, right| {
        right
            .timestamp
            .cmp(&left.timestamp)
            .then_with(|| left.document_file_id.cmp(&right.document_file_id))
            .then_with(|| left.action_type.cmp(&right.action_type))
    });
    result.activities.dedup_by(|left, right| {
        left.document_file_id == right.document_file_id
            && left.action_type == right.action_type
            && left.timestamp == right.timestamp
            && left.actor_email == right.actor_email
            && left.actor_display_name == right.actor_display_name
    });
    Ok(result)
}

async fn fetch_drive_metadata(
    sq_path: &Path,
    file_id: &str,
) -> Result<DriveDocumentMetadata, String> {
    let args = [
        "agent-tools",
        "google-drive",
        "get-file-metadata",
        "--file-id-or-url",
        file_id,
        "--raw",
        "--timeout",
        DRIVE_TOOL_TIMEOUT_SECS,
    ];
    let unavailable = "Optional Google Drive metadata is unavailable";
    let output = run_sq_command(sq_path, &args, DRIVE_PROCESS_TIMEOUT, unavailable).await?;
    parse_drive_metadata(&output, file_id).map_err(|error| format!("{unavailable}: {error}"))
}

async fn fetch_drive_activity(
    sq_path: &Path,
    file_id: &str,
    start_time: &str,
    end_time: Option<&str>,
) -> Result<Vec<ParsedDriveActivity>, String> {
    let mut args = vec![
        "agent-tools",
        "google-drive",
        "activity",
        "--start-time",
        start_time,
    ];
    if let Some(end_time) = end_time {
        args.extend(["--end-time", end_time]);
    }
    args.extend([
        "--item-id",
        file_id,
        "--activity-type",
        "edit",
        "comment",
        "--lookup-people",
        "--raw",
        "--timeout",
        DRIVE_TOOL_TIMEOUT_SECS,
    ]);
    let unavailable = "Optional Google Drive activity is unavailable";
    let output = run_sq_command(sq_path, &args, DRIVE_PROCESS_TIMEOUT, unavailable).await?;
    parse_drive_activity(&output, file_id).map_err(|error| format!("{unavailable}: {error}"))
}

async fn run_sq_command(
    sq_path: &Path,
    args: &[&str],
    process_timeout: Duration,
    unavailable: &str,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new(sq_path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|error| format!("{unavailable}: failed to start `sq`: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{unavailable}: failed to capture `sq` output"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{unavailable}: failed to capture `sq` errors"))?;

    let (status, stdout, stderr) = tokio::time::timeout(process_timeout, async move {
        let (stdout, stderr, status) = tokio::join!(
            read_bounded(stdout, MAX_CALENDAR_STDOUT_BYTES),
            read_bounded(stderr, MAX_CALENDAR_STDERR_BYTES),
            child.wait(),
        );
        Ok::<_, std::io::Error>((status?, stdout?, stderr?))
    })
    .await
    .map_err(|_| format!("{unavailable}: lookup timed out"))?
    .map_err(|error| format!("{unavailable}: failed while running `sq`: {error}"))?;
    if !status.success() {
        return Err(format!(
            "{unavailable}: {}",
            first_safe_line(&stderr).unwrap_or("tool lookup failed")
        ));
    }
    Ok(stdout)
}

async fn read_bounded(
    reader: impl AsyncRead + Unpin,
    max_bytes: usize,
) -> Result<Vec<u8>, std::io::Error> {
    let mut bytes = Vec::new();
    reader
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "tool response exceeded the size limit",
        ));
    }
    Ok(bytes)
}

fn first_safe_line(stderr: &[u8]) -> Option<&str> {
    std::str::from_utf8(stderr)
        .ok()?
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.chars().any(char::is_control))
}

fn validate_google_calendar_event_url(raw: &str) -> Result<(), String> {
    if raw != raw.trim() || raw.len() > 8 * 1024 || raw.chars().any(char::is_control) {
        return Err("invalid Google Calendar event URL".to_string());
    }
    let url = url::Url::parse(raw).map_err(|_| "invalid Google Calendar event URL".to_string())?;
    let is_google_host = matches!(
        url.host_str(),
        Some("www.google.com" | "calendar.google.com")
    );
    let event_ids = url
        .query_pairs()
        .filter(|(key, _)| key == "eid")
        .collect::<Vec<_>>();
    if url.scheme() != "https"
        || !is_google_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/calendar/event"
        || url.fragment().is_some()
        || event_ids.len() != 1
        || event_ids[0].1.is_empty()
        || event_ids[0].1.chars().any(char::is_control)
    {
        return Err("URL is not a supported Google Calendar event".to_string());
    }
    Ok(())
}

fn validate_activity_window(start_time: &str, end_time: Option<&str>) -> Result<(), String> {
    let start = DateTime::parse_from_rfc3339(start_time)
        .map_err(|_| "invalid Drive activity start time; expected RFC 3339".to_string())?;
    if let Some(end_time) = end_time {
        let end = DateTime::parse_from_rfc3339(end_time)
            .map_err(|_| "invalid Drive activity end time; expected RFC 3339".to_string())?;
        if end <= start {
            return Err("Drive activity end time must be after start time".to_string());
        }
    }
    Ok(())
}

fn google_drive_file_id(raw: &str) -> Option<String> {
    if raw != raw.trim() || raw.len() > 8 * 1024 || raw.chars().any(char::is_control) {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    let segments = url.path_segments()?.collect::<Vec<_>>();
    let candidate = match host {
        "docs.google.com"
            if segments.first() == Some(&"document") && segments.get(1) == Some(&"d") =>
        {
            segments.get(2).copied()
        }
        "drive.google.com"
            if segments.first() == Some(&"file") && segments.get(1) == Some(&"d") =>
        {
            segments.get(2).copied()
        }
        "drive.google.com" if url.path() == "/open" => {
            let ids = url
                .query_pairs()
                .filter(|(key, _)| key == "id")
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>();
            if ids.len() == 1 {
                return valid_drive_file_id(&ids[0]).then(|| ids[0].clone());
            }
            None
        }
        _ => None,
    }?;
    valid_drive_file_id(candidate).then(|| candidate.to_string())
}

fn valid_drive_file_id(candidate: &str) -> bool {
    (10..=128).contains(&candidate.len())
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn parse_drive_metadata(
    output: &[u8],
    expected_file_id: &str,
) -> Result<DriveDocumentMetadata, String> {
    let value: Value = serde_json::from_slice(output)
        .map_err(|error| format!("invalid Drive metadata response: {error}"))?;
    if let Some(metadata) = find_drive_metadata(&value, expected_file_id) {
        return Ok(metadata);
    }
    let mut texts = Vec::new();
    collect_content_text(&value, &mut texts);
    texts
        .iter()
        .find_map(|text| parse_drive_metadata_text(text, expected_file_id))
        .ok_or_else(|| "metadata did not identify the attached Google document".to_string())
}

fn find_drive_metadata(value: &Value, expected_file_id: &str) -> Option<DriveDocumentMetadata> {
    match value {
        Value::Object(object) => {
            let file_id = ["id", "fileId", "file_id"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str));
            let mime_type = ["mimeType", "mime_type"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str));
            let title = ["name", "title"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str));
            let document_url = ["webViewLink", "web_view_link", "url"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str));
            if file_id == Some(expected_file_id)
                && mime_type == Some("application/vnd.google-apps.document")
            {
                let title = title?.trim();
                let document_url = document_url?.trim();
                if !title.is_empty()
                    && !title.chars().any(char::is_control)
                    && google_drive_file_id(document_url).as_deref() == Some(expected_file_id)
                {
                    return Some(DriveDocumentMetadata {
                        file_id: expected_file_id.to_string(),
                        title: title.to_string(),
                        url: document_url.to_string(),
                    });
                }
            }
            for child in object.values() {
                if let Some(metadata) = find_drive_metadata(child, expected_file_id) {
                    return Some(metadata);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(|child| find_drive_metadata(child, expected_file_id)),
        Value::String(text) => parse_embedded_json(text)
            .as_ref()
            .and_then(|embedded| find_drive_metadata(embedded, expected_file_id)),
        _ => None,
    }
}

fn parse_embedded_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    let trimmed = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .strip_suffix("```")
        .unwrap_or(trimmed)
        .trim();
    serde_json::from_str(trimmed).ok()
}

fn parse_drive_metadata_text(text: &str, expected_file_id: &str) -> Option<DriveDocumentMetadata> {
    let mut file_id = None;
    let mut title = None;
    let mut mime_type = None;
    let mut document_url = None;
    for line in text.lines() {
        let line = line.trim().trim_start_matches(['-', '*', '#']).trim();
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key
            .trim_matches(|character: char| {
                matches!(character, '*' | '`') || character.is_whitespace()
            })
            .to_ascii_lowercase();
        let value = value.trim_matches(|character: char| {
            matches!(character, '*' | '`') || character.is_whitespace()
        });
        match key.as_str() {
            "id" | "file id" => file_id = Some(value),
            "name" | "title" => title = Some(value),
            "mime type" | "mimetype" => mime_type = Some(value),
            "web view link" | "webviewlink" | "url" => document_url = Some(value),
            _ => {}
        }
    }
    if file_id != Some(expected_file_id)
        || mime_type != Some("application/vnd.google-apps.document")
    {
        return None;
    }
    let title = title?;
    let document_url = document_url?;
    if title.is_empty()
        || title.chars().any(char::is_control)
        || google_drive_file_id(document_url).as_deref() != Some(expected_file_id)
    {
        return None;
    }
    Some(DriveDocumentMetadata {
        file_id: expected_file_id.to_string(),
        title: title.to_string(),
        url: document_url.to_string(),
    })
}

fn parse_drive_activity(
    output: &[u8],
    expected_file_id: &str,
) -> Result<Vec<ParsedDriveActivity>, String> {
    let Some(text) = drive_activity_text(output)? else {
        return Ok(Vec::new());
    };
    let mut activities = text
        .lines()
        .filter_map(|line| parse_drive_activity_line(line, expected_file_id))
        .collect::<Vec<_>>();
    activities.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    activities.dedup();
    if activities.is_empty() && !is_empty_activity_text(&text) {
        return Err(
            "Drive activity response contained no recognized edit or comment events".into(),
        );
    }
    Ok(activities)
}

fn is_empty_activity_text(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return true;
    }
    let lowercase = text.to_ascii_lowercase();
    if lowercase.contains("no activity")
        || lowercase.contains("no recent activity")
        || lowercase.contains("no drive activity")
        || lowercase.contains("no matching activity")
        || lowercase.contains("no events")
    {
        return true;
    }
    parse_embedded_json(text)
        .as_ref()
        .is_some_and(is_explicit_empty_activity_value)
}

fn drive_activity_text(output: &[u8]) -> Result<Option<String>, String> {
    let raw = std::str::from_utf8(output)
        .map_err(|_| "Drive activity response was not UTF-8".to_string())?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Ok(Some(raw.to_string()));
    };
    let mut texts = Vec::new();
    collect_content_text(&value, &mut texts);
    texts.retain(|text| !text.trim().is_empty());
    if texts.is_empty() && is_explicit_empty_activity_response(&value) {
        return Ok(None);
    }
    if texts.is_empty() {
        return Err("Drive activity response did not contain text content".into());
    }
    Ok(Some(texts.join("\n")))
}

fn is_explicit_empty_activity_response(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            if object.get("is_error").and_then(Value::as_bool) == Some(true)
                || object.get("isError").and_then(Value::as_bool) == Some(true)
            {
                return false;
            }
            [
                "content",
                "activities",
                "activity",
                "events",
                "items",
                "result",
            ]
            .iter()
            .any(|key| {
                object
                    .get(*key)
                    .is_some_and(is_explicit_empty_activity_value)
            })
        }
        _ => false,
    }
}

fn is_explicit_empty_activity_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Array(values) => {
            values.is_empty() || values.iter().all(is_explicit_empty_activity_value)
        }
        Value::String(text) => text.trim().is_empty(),
        Value::Object(object) => {
            if let Some(text) = object.get("text") {
                return is_explicit_empty_activity_value(text);
            }
            ["activities", "activity", "events", "items", "result"]
                .iter()
                .any(|key| {
                    object
                        .get(*key)
                        .is_some_and(is_explicit_empty_activity_value)
                })
        }
        _ => false,
    }
}

fn collect_content_text(value: &Value, texts: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                texts.push(text.to_string());
                return;
            }
            for child in object.values() {
                collect_content_text(child, texts);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_content_text(child, texts);
            }
        }
        _ => {}
    }
}

fn parse_drive_activity_line(line: &str, expected_file_id: &str) -> Option<ParsedDriveActivity> {
    let line = line.trim().strip_prefix("- ").unwrap_or(line.trim());
    let after_open = line.strip_prefix('[')?;
    let (timestamp, rest) = after_open.split_once("] ")?;
    let timestamp = parse_drive_activity_timestamp(timestamp)?;
    let (action, rest) = rest.split_once(" by ")?;
    let action = action.to_ascii_lowercase();
    let action_type = if action.contains("comment") {
        "comment"
    } else if action.contains("edit") {
        "edit"
    } else {
        return None;
    };
    let (actor, target) = rest.split_once(" on \"")?;
    let (_, detail) = target.rsplit_once("\" (")?;
    let reported_file_id = detail
        .split("id: ")
        .nth(1)?
        .split([',', ')'])
        .next()?
        .trim();
    let file_id = reported_file_id
        .strip_prefix("items/")
        .unwrap_or(reported_file_id);
    if file_id != expected_file_id || !valid_drive_file_id(file_id) {
        return None;
    }
    let (actor_display_name, actor_email) = parse_drive_actor(actor.trim());
    Some(ParsedDriveActivity {
        action_type: action_type.to_string(),
        timestamp,
        actor_display_name,
        actor_email,
    })
}

fn parse_drive_activity_timestamp(raw: &str) -> Option<String> {
    let timestamp = DateTime::parse_from_rfc3339(raw)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .or_else(|_| {
            NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f")
                .map(|timestamp| timestamp.and_utc())
        })
        .ok()?;
    Some(timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn parse_drive_actor(actor: &str) -> (Option<String>, Option<String>) {
    let actor = actor.trim();
    if let Some((name, email)) = actor
        .strip_suffix(')')
        .and_then(|value| value.rsplit_once(" ("))
    {
        if valid_actor_email(email) {
            return (nonempty_actor_name(name), Some(email.to_string()));
        }
    }
    if let Some((name, email)) = actor
        .strip_suffix('>')
        .and_then(|value| value.rsplit_once(" <"))
    {
        if valid_actor_email(email) {
            return (nonempty_actor_name(name), Some(email.to_string()));
        }
    }
    if valid_actor_email(actor) {
        return (None, Some(actor.to_string()));
    }
    (nonempty_actor_name(actor), None)
}

fn nonempty_actor_name(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control))
        .then(|| name.to_string())
}

fn valid_actor_email(email: &str) -> bool {
    email.len() <= 254
        && email.contains('@')
        && !email
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

fn parse_calendar_links(output: &[u8]) -> Result<Vec<CollectionDiscoveredLink>, String> {
    let response: CalendarToolResponse = serde_json::from_slice(output)
        .map_err(|error| format!("invalid Google Calendar response: {error}"))?;
    let attachments = response
        .result
        .map_or(response.attachments, |result| result.attachments);
    let mut links = Vec::new();
    for attachment in attachments {
        if attachment.file_url != attachment.file_url.trim()
            || attachment.file_url.chars().any(char::is_control)
        {
            continue;
        }
        let Ok(url) = url::Url::parse(&attachment.file_url) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || google_drive_file_id(url.as_str()).is_none()
        {
            continue;
        }
        links.push(CollectionDiscoveredLink {
            url: url.to_string(),
            label: if attachment.title.trim().is_empty() {
                url.host_str().unwrap_or_default().to_string()
            } else {
                attachment.title.trim().to_string()
            },
            kind: "document".to_string(),
        });
    }
    links.sort_by(|left, right| left.url.cmp(&right.url));
    links.dedup_by(|left, right| left.url == right.url);
    Ok(links)
}

#[cfg(test)]
mod tests;

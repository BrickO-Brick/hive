use super::super::{
    parse_uuid, AddCollectionMemberInput, CreateCollectionInput, SetCollectionIconInput,
    SetCollectionNameInput,
};
use super::*;
use buzz_collections_pkg::CollectionReference;

#[test]
fn command_ids_are_validated_before_store_access() {
    assert!(parse_uuid("not-a-uuid", "collection").is_err());
    assert!(parse_uuid("9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50", "collection").is_ok());
}

#[test]
fn add_member_input_accepts_desktop_thread_payload() {
    let input: AddCollectionMemberInput = serde_json::from_value(serde_json::json!({
        "relay_url": "wss://buzz.block.builderlab.xyz",
        "owner_pubkey": "67252b09c31a995daa63aada26569fbc6a3d12f573113f001ce7432f870da820",
        "collection_id": "593a7412-49ee-4709-ac66-17f6e6288279",
        "reference": {
            "type": "thread",
            "channel_id": "7f4a6441-4028-4cf5-8872-de456856d68e",
            "root_event_id": "b016509b88c9c1cdc615f7101b779104a3101758f54e6a48a10a2e51843ff358"
        },
        "label": "Thread: production payload"
    }))
    .expect("desktop thread payload should deserialize");

    assert!(matches!(
        input.reference,
        CollectionReference::Thread { .. }
    ));
}

#[test]
fn icon_inputs_accept_create_set_and_clear_payloads() {
    let create: CreateCollectionInput = serde_json::from_value(serde_json::json!({
        "relay_url": "wss://buzz.block.builderlab.xyz",
        "owner_pubkey": "67252b09c31a995daa63aada26569fbc6a3d12f573113f001ce7432f870da820",
        "name": "Bird Voice",
        "description": null,
        "icon": "🐦"
    }))
    .expect("create icon payload");
    assert_eq!(create.icon.as_deref(), Some("🐦"));

    let set: SetCollectionIconInput = serde_json::from_value(serde_json::json!({
        "relay_url": "wss://buzz.block.builderlab.xyz",
        "owner_pubkey": "67252b09c31a995daa63aada26569fbc6a3d12f573113f001ce7432f870da820",
        "collection_id": "593a7412-49ee-4709-ac66-17f6e6288279",
        "icon": "🎧"
    }))
    .expect("set icon payload");
    assert_eq!(set.icon.as_deref(), Some("🎧"));

    let clear: SetCollectionIconInput = serde_json::from_value(serde_json::json!({
        "relay_url": "wss://buzz.block.builderlab.xyz",
        "owner_pubkey": "67252b09c31a995daa63aada26569fbc6a3d12f573113f001ce7432f870da820",
        "collection_id": "593a7412-49ee-4709-ac66-17f6e6288279",
        "icon": null
    }))
    .expect("clear icon payload");
    assert_eq!(clear.icon, None);
}

#[test]
fn rename_input_accepts_desktop_payload() {
    let input: SetCollectionNameInput = serde_json::from_value(serde_json::json!({
        "relay_url": "wss://buzz.block.builderlab.xyz",
        "owner_pubkey": "67252b09c31a995daa63aada26569fbc6a3d12f573113f001ce7432f870da820",
        "collection_id": "593a7412-49ee-4709-ac66-17f6e6288279",
        "name": "Berd Voice"
    }))
    .expect("rename payload");
    assert_eq!(input.name, "Berd Voice");
}

#[test]
fn calendar_discovery_only_accepts_google_event_links() {
    assert!(validate_google_calendar_event_url(
        "https://www.google.com/calendar/event?eid=abc123&ctz=UTC"
    )
    .is_ok());
    assert!(
        validate_google_calendar_event_url("https://example.com/calendar/event?eid=abc").is_err()
    );
    assert!(validate_google_calendar_event_url("https://www.google.com/calendar/event").is_err());
    assert!(validate_google_calendar_event_url(
        "https://attacker@example.com/calendar/event?eid=abc"
    )
    .is_err());
    assert!(validate_google_calendar_event_url(
        "https://www.google.com:444/calendar/event?eid=abc"
    )
    .is_err());
    assert!(validate_google_calendar_event_url(
        "https://www.google.com/calendar/event?eid=abc#fragment"
    )
    .is_err());
    assert!(validate_google_calendar_event_url(
        "https://www.google.com/calendar/event?eid=abc&eid=second"
    )
    .is_err());
}

#[test]
fn calendar_discovery_returns_document_links_without_persisting_them() {
    let file_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
    let output = serde_json::json!({
        "result": {
            "attachments": [
                {"fileUrl": format!("https://docs.google.com/document/d/{file_id}/edit"), "title": "Notes by Gemini"},
                {"fileUrl": "file:///tmp/private", "title": "Local file"},
                {"fileUrl": "https://user:secret@example.com/private", "title": "Credentials"},
                {"fileUrl": "https://example.com/meeting-notes.pdf", "title": "Arbitrary PDF"},
                {"fileUrl": "https://docs.google.com/document/d/too-short/edit", "title": "Malformed Drive ID"},
                {"fileUrl": format!("https://docs.google.com/document/d/{file_id}/edit"), "title": "Duplicate"}
            ]
        }
    });
    let links = parse_calendar_links(output.to_string().as_bytes()).expect("calendar links");
    assert_eq!(
        links,
        vec![CollectionDiscoveredLink {
            url: format!("https://docs.google.com/document/d/{file_id}/edit"),
            label: "Notes by Gemini".to_string(),
            kind: "document".to_string(),
        }]
    );
}

#[test]
fn calendar_discovery_accepts_direct_event_json() {
    let drive_file_id = "1DriveFileAttachmentId_123456789";
    let docs_file_id = "1DocsFileAttachmentId_1234567890";
    let output = serde_json::json!({
        "attachments": [
            {"fileUrl": format!("https://drive.google.com/file/d/{drive_file_id}/view"), "title": " Drive file "},
            {"fileUrl": "javascript:alert(1)", "title": "Unsafe"},
            {"fileUrl": format!("https://docs.google.com/document/d/{docs_file_id}/edit"), "title": ""},
            {"fileUrl": "https://example.com/no-title", "title": "Website"}
        ]
    });
    let links = parse_calendar_links(output.to_string().as_bytes()).expect("calendar links");
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].label, "docs.google.com");
    assert_eq!(links[1].label, "Drive file");
}

#[test]
fn drive_file_ids_only_come_from_strict_attachment_urls() {
    let file_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
    assert_eq!(
        google_drive_file_id(&format!(
            "https://docs.google.com/document/d/{file_id}/edit"
        )),
        Some(file_id.to_string())
    );
    assert_eq!(
        google_drive_file_id(&format!("https://drive.google.com/file/d/{file_id}/view")),
        Some(file_id.to_string())
    );
    assert_eq!(
        google_drive_file_id(&format!("https://drive.google.com/open?id={file_id}")),
        Some(file_id.to_string())
    );
    assert!(google_drive_file_id(&format!(
        "https://docs.google.com.evil.example/document/d/{file_id}/edit"
    ))
    .is_none());
    assert!(google_drive_file_id(&format!(
        "https://user@docs.google.com/document/d/{file_id}/edit"
    ))
    .is_none());
    assert!(google_drive_file_id(&format!(
        "https://docs.google.com/spreadsheets/d/{file_id}/edit"
    ))
    .is_none());
    assert!(google_drive_file_id("https://drive.google.com/file/d/too-short/view").is_none());
}

#[test]
fn drive_metadata_must_match_the_attached_google_doc() {
    let file_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
    let output = serde_json::json!({
        "content": [{"type": "text", "text": "metadata loaded"}],
        "structuredContent": {
            "id": file_id,
            "name": "Launch notes",
            "mimeType": "application/vnd.google-apps.document",
            "webViewLink": format!("https://docs.google.com/document/d/{file_id}/edit")
        }
    });
    let metadata = parse_drive_metadata(output.to_string().as_bytes(), file_id).expect("metadata");
    assert_eq!(metadata.title, "Launch notes");
    assert_eq!(metadata.file_id, file_id);

    assert!(parse_drive_metadata(output.to_string().as_bytes(), "differentFileId12345").is_err());
}

#[test]
fn drive_metadata_accepts_formatted_raw_content() {
    let file_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
    let output = serde_json::json!({
        "content": [{
            "type": "text",
            "text": format!(
                "## File metadata\n- **ID:** `{file_id}`\n- **Name:** Launch notes\n- **MIME type:** application/vnd.google-apps.document\n- **Web view link:** https://docs.google.com/document/d/{file_id}/edit"
            )
        }]
    });
    let metadata = parse_drive_metadata(output.to_string().as_bytes(), file_id).expect("metadata");
    assert_eq!(metadata.title, "Launch notes");
}

#[test]
fn drive_activity_parses_realistic_edit_and_comment_output() {
    let file_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
    let raw = serde_json::json!({
        "content": [{
            "text": {
                "text": format!(
                    "- [2026-08-27T13:42:01Z] EDIT by Ada Lovelace (ada@example.com) on \"Launch notes\" (type: drive#file, id: {file_id})\n- [2026-08-27T14:05:03-04:00] COMMENT by Grace Hopper <grace@example.com> on \"Launch notes\" (type: drive#file, id: {file_id})\n- [2026-08-27T14:06:00Z] RENAME by Someone on \"Launch notes\" (type: drive#file, id: {file_id})\n- [2026-08-27T14:07:00Z] EDIT by Attacker on \"Other\" (type: drive#file, id: 1OtherValidatedFileId987654321)"
                )
            }
        }]
    });
    let activities = parse_drive_activity(raw.to_string().as_bytes(), file_id).expect("activity");
    assert_eq!(activities.len(), 2);
    assert_eq!(activities[0].action_type, "comment");
    assert_eq!(activities[0].timestamp, "2026-08-27T18:05:03.000Z");
    assert_eq!(
        activities[0].actor_display_name.as_deref(),
        Some("Grace Hopper")
    );
    assert_eq!(
        activities[0].actor_email.as_deref(),
        Some("grace@example.com")
    );
    assert_eq!(activities[1].action_type, "edit");
    assert_eq!(
        activities[1].actor_display_name.as_deref(),
        Some("Ada Lovelace")
    );
    assert_eq!(
        activities[1].actor_email.as_deref(),
        Some("ada@example.com")
    );
}

#[test]
fn drive_activity_parses_live_naive_utc_timestamp_and_item_id() {
    let file_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
    let raw = serde_json::json!({
        "content": [{
            "text": {
                "text": format!(
                    "- [2026-08-27 18:09:30] EDIT by Ada Lovelace (ada@example.com) on \"Launch notes\" (type: drive#file, id: items/{file_id})\n- [2026-08-27 18:10:31] COMMENT by Grace Hopper on \"Launch notes\" (type: drive#file, id: items/{file_id})\n- [2026-08-27 18:11:32] EDIT by Wrong File on \"Other\" (type: drive#file, id: items/1OtherValidatedFileId987654321)"
                )
            }
        }],
        "is_error": false
    });
    let activities =
        parse_drive_activity(raw.to_string().as_bytes(), file_id).expect("live activity");
    assert_eq!(activities.len(), 2);
    assert_eq!(activities[0].action_type, "comment");
    assert_eq!(activities[0].timestamp, "2026-08-27T18:10:31.000Z");
    assert_eq!(activities[1].action_type, "edit");
    assert_eq!(activities[1].timestamp, "2026-08-27T18:09:30.000Z");
}

#[test]
fn drive_activity_accepts_explicit_empty_structured_responses() {
    let file_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
    for output in [
        serde_json::json!({"content": [], "is_error": false}),
        serde_json::json!({
            "content": [{"text": {"text": ""}}],
            "is_error": false
        }),
        serde_json::json!({
            "content": [],
            "structuredContent": {"activities": []},
            "is_error": false
        }),
        serde_json::json!({
            "content": [{"text": {"text": "No Drive activity found."}}],
            "is_error": false
        }),
        serde_json::json!({
            "content": [
                {"text": {"text": "No recent activity found."}},
                {"structured_content": {"data": {"result": "No recent activity found."}}}
            ],
            "is_error": false,
            "structured_content_json": "{\"result\":\"No recent activity found.\"}"
        }),
        serde_json::json!({
            "content": [{"text": {"text": "[]"}}],
            "is_error": false
        }),
    ] {
        assert!(parse_drive_activity(output.to_string().as_bytes(), file_id)
            .expect("empty activity response")
            .is_empty());
    }
}

#[test]
fn drive_activity_rejects_malformed_nonempty_responses() {
    let file_id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
    let output = serde_json::json!({
        "content": [{"text": {"text": "unexpected nonempty response"}}],
        "is_error": false
    });
    assert!(parse_drive_activity(output.to_string().as_bytes(), file_id).is_err());
}

#[test]
fn calendar_activity_serializes_provenance() {
    let activity = CollectionCalendarActivity {
        action_type: "comment".into(),
        timestamp: "2026-08-27T18:05:03.000Z".into(),
        actor_display_name: Some("Grace Hopper".into()),
        actor_email: Some("grace@example.com".into()),
        document_title: "Launch notes".into(),
        document_url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_123456/edit"
            .into(),
        document_file_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456".into(),
        source_calendar_url: "https://www.google.com/calendar/event?eid=calendar-source".into(),
        source_attachment_url:
            "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_123456/view".into(),
    };
    let value = serde_json::to_value(activity).expect("serialize activity");
    assert_eq!(value["action_type"], "comment");
    assert_eq!(
        value["source_calendar_url"],
        "https://www.google.com/calendar/event?eid=calendar-source"
    );
    assert!(value["source_attachment_url"]
        .as_str()
        .is_some_and(|url| url.contains("drive.google.com/file/d/")));
}

#[test]
fn drive_activity_window_is_bounded_by_valid_rfc3339_inputs() {
    assert!(validate_activity_window("2026-08-26T00:00:00Z", Some("2026-08-27T00:00:00Z")).is_ok());
    assert!(validate_activity_window("yesterday", None).is_err());
    assert!(
        validate_activity_window("2026-08-27T00:00:00Z", Some("2026-08-26T00:00:00Z")).is_err()
    );
}

#[tokio::test]
async fn calendar_tool_output_is_bounded() {
    let error = read_bounded(&b"12345"[..], 4)
        .await
        .expect_err("oversized output should fail");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
}

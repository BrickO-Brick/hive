use super::*;
use nostr::{EventBuilder, Tag, Timestamp};

fn note(keys: &Keys, slug: &str, content: &str, created_at: u64) -> Event {
    EventBuilder::new(Kind::Custom(SHARED_INSTRUCTION_KIND), content)
        .tags([
            Tag::parse(["d", slug]).unwrap(),
            Tag::parse(["title", &format!("Title {slug}")]).unwrap(),
            Tag::parse(["summary", &format!("Summary {slug}")]).unwrap(),
        ])
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(keys)
        .unwrap()
}

#[test]
fn assigned_shared_instruction_env_is_canonical() {
    let coordinate = format!("30023:{}:review", "a".repeat(64));
    let mut command = std::process::Command::new("buzz-acp");
    command.env(ASSIGNED_SHARED_INSTRUCTIONS_ENV, "user-supplied");
    apply_assigned_shared_instructions_env(&mut command, std::slice::from_ref(&coordinate));
    let env = command
        .get_envs()
        .find(|(key, _)| *key == ASSIGNED_SHARED_INSTRUCTIONS_ENV)
        .and_then(|(_, value)| value)
        .and_then(|value| value.to_str());
    assert_eq!(env, Some(coordinate.as_str()));
}

#[test]
fn effective_assigned_shared_instruction_env_uses_live_definition() {
    let stale = format!("30023:{}:revoked", "a".repeat(64));
    let current = format!("30023:{}:kept", "b".repeat(64));
    let record: super::super::ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": "agent",
        "name": "agent",
        "persona_id": "persona",
        "private_key_nsec": "nsec1fake",
        "relay_url": "wss://relay.example",
        "acp_command": "buzz-acp",
        "agent_command": "goose",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 300,
        "parallelism": 1,
        "assigned_shared_instructions": [stale.clone()],
        "created_at": "now",
        "updated_at": "now"
    }))
    .unwrap();
    let definition: super::super::AgentDefinition = serde_json::from_value(serde_json::json!({
        "id": "persona",
        "display_name": "Persona",
        "system_prompt": "prompt",
        "name_pool": [],
        "is_builtin": false,
        "is_active": true,
        "assigned_shared_instructions": [current.clone()],
        "created_at": "now",
        "updated_at": "now"
    }))
    .unwrap();
    let mut command = std::process::Command::new("buzz-acp");

    let definitions = [definition];
    let assigned = resolve_and_apply_assigned_shared_instructions_env(
        &mut command,
        &record,
        &definitions,
        true,
    )
    .unwrap();
    assert_eq!(assigned, definitions[0].assigned_shared_instructions);

    let env = command
        .get_envs()
        .find(|(key, _)| *key == ASSIGNED_SHARED_INSTRUCTIONS_ENV)
        .and_then(|(_, value)| value)
        .and_then(|value| value.to_str());
    assert_eq!(env, Some(current.as_str()));
}

#[test]
fn disabled_shared_instructions_remove_env_and_effective_assignment() {
    let coordinate = format!("30023:{}:kept", "a".repeat(64));
    let record: super::super::ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": "agent",
        "name": "agent",
        "private_key_nsec": "nsec1fake",
        "relay_url": "wss://relay.example",
        "acp_command": "buzz-acp",
        "agent_command": "goose",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 300,
        "parallelism": 1,
        "assigned_shared_instructions": [coordinate],
        "created_at": "now",
        "updated_at": "now"
    }))
    .unwrap();
    let mut command = std::process::Command::new("buzz-acp");
    command.env(ASSIGNED_SHARED_INSTRUCTIONS_ENV, "user-supplied");

    let assigned =
        resolve_and_apply_assigned_shared_instructions_env(&mut command, &record, &[], false)
            .unwrap();

    assert!(assigned.is_empty());
    assert!(command
        .get_envs()
        .find(|(key, _)| *key == ASSIGNED_SHARED_INSTRUCTIONS_ENV)
        .is_some_and(|(_, value)| value.is_none()));
}

#[test]
fn accepts_exact_coordinate_and_deduplicates() {
    let key = "a".repeat(64);
    let coordinate = format!("30023:{key}:design-engineering");
    assert_eq!(
        validate_assigned_shared_instructions(vec![coordinate.clone(), coordinate.clone()])
            .unwrap(),
        vec![coordinate]
    );
}

#[test]
fn rejects_noncanonical_coordinates() {
    let key = "a".repeat(64);
    for invalid in [
        "design-engineering".to_string(),
        format!("30175:{key}:design-engineering"),
        format!("30023:{key}:design\nengineering"),
        format!("30023:{key}:Design-Engineering"),
        format!("30023:{key}:design/engineering"),
        format!("30023:{}:design-engineering", "A".repeat(64)),
        "30023:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3d0u5:design-engineering"
            .to_string(),
    ] {
        assert!(
            parse_shared_instruction_coordinate(&invalid).is_err(),
            "{invalid:?}"
        );
    }
}

#[test]
fn projects_mine_only_latest_heads_with_explicit_compatibility() {
    let owner = Keys::generate();
    let stranger = Keys::generate();
    let old = note(&owner, "design-engineering", "old body", 10);
    let current = note(&owner, "design-engineering", "current body", 20);
    let invalid_name = note(&owner, "Design_skill", "body", 30);
    let missing_summary = EventBuilder::new(Kind::Custom(SHARED_INSTRUCTION_KIND), "body")
        .tags([
            Tag::parse(["d", "missing-summary"]).unwrap(),
            Tag::parse(["title", "Missing summary"]).unwrap(),
        ])
        .custom_created_at(Timestamp::from(40))
        .sign_with_keys(&owner)
        .unwrap();
    let foreign = note(&stranger, "foreign", "body", 50);

    let covers = shared_instruction_covers_from_events(
        &owner.public_key().to_hex(),
        vec![old, current, invalid_name, missing_summary, foreign],
    );

    assert_eq!(covers.len(), 3);
    assert_eq!(covers[0].slug, "missing-summary");
    assert!(!covers[0].compatible);
    assert_eq!(
        covers[0].incompatibilities[0].code,
        SharedInstructionIncompatibilityCode::MissingDescription
    );
    assert_eq!(covers[1].slug, "Design_skill");
    assert!(!covers[1].compatible);
    assert_eq!(
        covers[1].incompatibilities[0].code,
        SharedInstructionIncompatibilityCode::InvalidName
    );
    assert_eq!(covers[2].slug, "design-engineering");
    assert!(covers[2].compatible);
    assert!(covers[2].incompatibilities.is_empty());
    assert_eq!(covers[2].updated_at, 20);
}

#[test]
fn validation_rejects_instruction_name_edge_cases_and_empty_body() {
    for slug in ["", "-skill", "skill-", "two--hyphens", "with_underscore"] {
        let reasons = shared_instruction_incompatibilities(slug, Some("Useful summary"), "body");
        assert!(reasons
            .iter()
            .any(|reason| reason.code == SharedInstructionIncompatibilityCode::InvalidName));
    }
    let reasons = shared_instruction_incompatibilities("valid-name", Some("summary"), "\n");
    assert_eq!(
        reasons[0].code,
        SharedInstructionIncompatibilityCode::EmptyBody
    );
}

#[test]
fn exact_query_filters_do_not_admit_author_slug_cross_products() {
    let alpha = Keys::generate();
    let beta = Keys::generate();
    let coordinates = [
        format!("30023:{}:alpha", alpha.public_key().to_hex()),
        format!("30023:{}:beta", beta.public_key().to_hex()),
    ]
    .iter()
    .map(|value| parse_shared_instruction_coordinate(value).unwrap())
    .collect::<Vec<_>>();

    let filters = exact_coordinate_filters(&coordinates);

    assert_eq!(filters.len(), 2);
    assert_eq!(
        filters[0]["authors"],
        serde_json::json!([alpha.public_key().to_hex()])
    );
    assert_eq!(filters[0]["#d"], serde_json::json!(["alpha"]));
    assert_eq!(filters[0]["limit"], serde_json::json!(1));
    assert_eq!(
        filters[1]["authors"],
        serde_json::json!([beta.public_key().to_hex()])
    );
    assert_eq!(filters[1]["#d"], serde_json::json!(["beta"]));
}

#[test]
fn resolves_only_exact_requested_signer_and_slug() {
    let alpha = Keys::generate();
    let beta = Keys::generate();
    let coordinate = format!("30023:{}:design-engineering", alpha.public_key().to_hex());
    let wrong_author_same_slug = note(&beta, "design-engineering", "wrong author", 20);
    let right_author_wrong_slug = note(&alpha, "other", "wrong slug", 30);
    let expected = note(&alpha, "design-engineering", "trusted body", 10);

    let resolved = resolved_heads_from_events(
        std::slice::from_ref(&coordinate),
        vec![
            wrong_author_same_slug,
            right_author_wrong_slug,
            expected.clone(),
        ],
    );

    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].coordinate, coordinate);
    assert_eq!(resolved[0].publisher, alpha.public_key().to_hex());
    assert_eq!(resolved[0].slug, "design-engineering");
    assert_eq!(resolved[0].content, "trusted body");
    assert_eq!(
        resolved[0].summary.as_deref(),
        Some("Summary design-engineering")
    );
    assert_eq!(resolved[0].event_id, expected.id.to_hex());
}

#[test]
fn selects_newest_verified_head_and_preserves_assignment_order() {
    let alpha = Keys::generate();
    let beta = Keys::generate();
    let alpha_coordinate = format!("30023:{}:alpha", alpha.public_key().to_hex());
    let beta_coordinate = format!("30023:{}:beta", beta.public_key().to_hex());
    let old_alpha = note(&alpha, "alpha", "old", 10);
    let new_alpha = note(&alpha, "alpha", "new", 20);
    let beta_note = note(&beta, "beta", "beta", 15);

    let resolved = resolved_heads_from_events(
        &[beta_coordinate.clone(), alpha_coordinate.clone()],
        vec![old_alpha, new_alpha, beta_note],
    );

    assert_eq!(
        resolved
            .iter()
            .map(|skill| skill.coordinate.as_str())
            .collect::<Vec<_>>(),
        vec![beta_coordinate.as_str(), alpha_coordinate.as_str()]
    );
    assert_eq!(resolved[1].content, "new");
}

#[test]
fn rejects_tampered_oversize_and_ambiguous_coordinate_events() {
    let keys = Keys::generate();
    let coordinate = format!("30023:{}:skill", keys.public_key().to_hex());
    let mut tampered = note(&keys, "skill", "original", 10);
    tampered.content = "tampered".to_string();
    let oversize = note(
        &keys,
        "skill",
        &"x".repeat(MAX_SHARED_INSTRUCTION_BODY_BYTES + 1),
        20,
    );
    let ambiguous = EventBuilder::new(Kind::Custom(SHARED_INSTRUCTION_KIND), "ambiguous")
        .tags([
            Tag::parse(["d", "skill"]).unwrap(),
            Tag::parse(["d", "skill"]).unwrap(),
        ])
        .custom_created_at(Timestamp::from(30))
        .sign_with_keys(&keys)
        .unwrap();

    assert!(
        resolved_heads_from_events(&[coordinate], vec![tampered, oversize, ambiguous]).is_empty()
    );
}

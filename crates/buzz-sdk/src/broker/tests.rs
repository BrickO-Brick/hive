//! Contract tests for the broker envelope, actions, and client trait.

use super::*;

const CHANNEL: &str = "b2c38ca8-9ec3-411e-bab5-f9deab34d52e";
const PUBKEY: &str = "a02c4e0850e5e612b4ddf95dbe2f5c56467cf27c6552203bc833ff438fb31971";
const EVENT: &str = "78d47c4f36a2d048f45b57a31d964a3ce239f0fc46162c5d7c90db2b5aa52bc6";

fn pubkey() -> PubkeyHex {
    PubkeyHex::parse(PUBKEY).expect("fixture pubkey is valid hex")
}

/// One valid `args` value per action, so table-driven tests cannot silently
/// skip an action: [`action_fixtures_cover_every_action`] pins the coverage.
fn action_fixtures() -> Vec<ActionArgs> {
    vec![
        ActionArgs::ChannelRead(
            ChannelReadArgs::channel(CHANNEL)
                .in_thread(EVENT)
                .mentions_only()
                .since(1_764_000_000)
                .limit(50),
        ),
        ActionArgs::MessagePost(MessagePostArgs {
            channel_id: CHANNEL.into(),
            content: "shipping the contract".into(),
            mentions: vec![pubkey()],
        }),
        ActionArgs::MessageReply(MessageReplyArgs {
            channel_id: CHANNEL.into(),
            reply_to_event_id: EVENT.into(),
            content: "agreed".into(),
            mentions: vec![],
        }),
        ActionArgs::ReactionAdd(ReactionAddArgs {
            channel_id: CHANNEL.into(),
            target_event_id: EVENT.into(),
            reaction: "🎉".into(),
        }),
        ActionArgs::ProfileSet(ProfileSetArgs {
            display_name: Some("ss-dev-00".into()),
            about: Some("implementation".into()),
            picture: None,
        }),
        ActionArgs::StorageAddress(StorageAddressArgs {
            slug: "mem/broker-foundation".into(),
        }),
        ActionArgs::AgentsCreate(AgentsCreateArgs {
            channel_id: CHANNEL.into(),
            display_name: "Research helper".into(),
            system_prompt: "Find sources.".into(),
            runtime: None,
            provider: None,
            model: None,
            respond_to: Some("owner-only".into()),
        }),
        ActionArgs::AgentsUpdate(AgentsUpdateArgs {
            target: AgentTarget::Pubkey(pubkey()),
            display_name: Some("Research helper v2".into()),
            system_prompt: None,
            runtime: None,
            provider: None,
            model: None,
            respond_to: None,
        }),
        ActionArgs::AgentsDelete(AgentsDeleteArgs {
            target: AgentTarget::Name("Research helper".into()),
        }),
    ]
}

/// One outcome per action, matching the fixture order above.
fn outcome_fixtures() -> Vec<ActionOutcome> {
    let page = MessagePage {
        messages: vec![BrokerMessage {
            event_id: EVENT.into(),
            author_pubkey: pubkey(),
            kind: 9,
            created_at: 1_764_000_001,
            content: "hello".into(),
            root_event_id: Some(EVENT.into()),
            parent_event_id: None,
            mentions: vec![pubkey()],
        }],
        next_cursor: Some(1_764_000_002),
    };
    let published = EventPublished {
        event_id: EVENT.into(),
        kind: 9,
        created_at: 1_764_000_003,
    };
    vec![
        ActionOutcome::ChannelRead(page),
        ActionOutcome::MessagePost(published.clone()),
        ActionOutcome::MessageReply(published.clone()),
        ActionOutcome::ReactionAdd(published.clone()),
        ActionOutcome::ProfileSet(published),
        ActionOutcome::StorageAddress(StorageAddress {
            author_pubkey: pubkey(),
            kind: 30174,
            d_tag: EVENT.into(),
        }),
        ActionOutcome::AgentsCreate(AgentsCreateOutcome {
            agent_pubkey: pubkey(),
            display_name: "Research helper".into(),
            channel_id: CHANNEL.into(),
        }),
        ActionOutcome::AgentsUpdate(AgentsUpdateOutcome {
            agent_pubkey: pubkey(),
            display_name: "Research helper v2".into(),
            updated_fields: vec!["displayName".into()],
        }),
        ActionOutcome::AgentsDelete(AgentsDeleteOutcome {
            agent_pubkey: pubkey(),
            display_name: "Research helper".into(),
        }),
    ]
}

// ── Coverage ────────────────────────────────────────────────────────────────

/// The fixture tables are the input to every table-driven test below, so an
/// action added without a fixture would be silently untested. This is the guard.
#[test]
fn action_fixtures_cover_every_action() {
    let mut from_args: Vec<&str> = action_fixtures()
        .iter()
        .map(|args| args.action().as_str())
        .collect();
    let mut from_outcomes: Vec<&str> = outcome_fixtures()
        .iter()
        .map(|outcome| outcome.action().as_str())
        .collect();
    let mut declared: Vec<&str> = Action::ALL.iter().map(|a| a.as_str()).collect();

    from_args.sort_unstable();
    from_outcomes.sort_unstable();
    declared.sort_unstable();

    assert_eq!(from_args, declared, "every action needs an args fixture");
    assert_eq!(
        from_outcomes, declared,
        "every action needs an outcome fixture"
    );
}

#[test]
fn action_names_are_unique_and_round_trip_through_parse() {
    let mut names: Vec<&str> = Action::ALL.iter().map(|a| a.as_str()).collect();
    let count = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), count, "action wire names must be unique");

    for action in Action::ALL {
        assert_eq!(Action::parse(action.as_str()).unwrap(), action);
    }
}

// ── Envelope round-trip ─────────────────────────────────────────────────────

#[test]
fn every_action_round_trips_through_a_request_envelope() {
    for args in action_fixtures() {
        let action = args.action();
        let request = BrokerRequest::new("req-1", args)
            .unwrap_or_else(|e| panic!("{} fixture must validate: {e}", action.as_str()));

        let json = serde_json::to_value(&request).expect("request serializes");
        assert_eq!(json["type"], BROKER_REQUEST_TYPE);
        assert_eq!(json["protocolVersion"], 1);
        assert_eq!(json["requestId"], "req-1");
        assert_eq!(json["actionVersion"], 1);
        assert_eq!(
            json["action"],
            action.as_str(),
            "{} must name itself on the wire",
            action.as_str()
        );
        assert!(
            json.get("args").is_some(),
            "{} must carry an args object",
            action.as_str()
        );

        let parsed: BrokerRequest = serde_json::from_value(json)
            .unwrap_or_else(|e| panic!("{} must deserialize: {e}", action.as_str()));
        assert_eq!(parsed, request);
        parsed.validate().expect("round-tripped request is valid");
    }
}

#[test]
fn every_outcome_round_trips_through_a_response_envelope() {
    for outcome in outcome_fixtures() {
        let action = outcome.action();
        let response = BrokerResponse::new("req-1", BrokerResult::succeeded(outcome.clone()));
        response.validate().expect("response is valid");

        let json = serde_json::to_value(&response).expect("response serializes");
        assert_eq!(json["type"], BROKER_RESULT_TYPE);
        assert_eq!(json["status"], "succeeded");
        assert_eq!(json["action"], action.as_str());
        assert!(json.get("error").is_none(), "a success carries no error");
        // `replayed` is delivery metadata and stays off the wire when false.
        assert!(json.get("replayed").is_none());

        let parsed: BrokerResponse = serde_json::from_value(json)
            .unwrap_or_else(|e| panic!("{} outcome must deserialize: {e}", action.as_str()));
        assert_eq!(parsed, response);
        assert_eq!(parsed.result.outcome(), Some(&outcome));
        assert!(parsed.result.error().is_none());
    }
}

/// Args and outcome share the `action` discriminator, so a payload can never
/// pair one action's name with another's shape.
#[test]
fn an_args_shape_cannot_be_paired_with_another_action_name() {
    let json = serde_json::json!({
        "type": BROKER_REQUEST_TYPE,
        "protocolVersion": 1,
        "requestId": "req-1",
        "actionVersion": 1,
        "action": "agents.delete",
        "args": { "channelId": CHANNEL, "content": "not a delete" },
    });
    assert!(serde_json::from_value::<BrokerRequest>(json).is_err());
}

// ── Envelope rejection ──────────────────────────────────────────────────────

#[test]
fn unknown_action_name_is_rejected() {
    for unknown in ["channel.write", "agents.exfiltrate", "", "channel.read "] {
        assert!(
            Action::parse(unknown).is_err(),
            "\"{unknown}\" must not parse as an action"
        );
    }

    let json = serde_json::json!({
        "type": BROKER_REQUEST_TYPE,
        "protocolVersion": 1,
        "requestId": "req-1",
        "actionVersion": 1,
        "action": "agents.exfiltrate",
        "args": {},
    });
    assert!(serde_json::from_value::<BrokerRequest>(json).is_err());
}

/// Signing and publishing are mechanisms, not actions. An interface that can
/// sign arbitrary bytes is a signing oracle, so these names must not resolve.
#[test]
fn signing_and_credential_access_are_not_actions() {
    for forbidden in [
        "sign",
        "sign_event",
        "publish",
        "nip44.encrypt",
        "nip44.decrypt",
        "nip42.auth",
        "nip98.auth",
        "keys.export",
        "identity.nsec",
        "tool.exec",
        "agents.manage",
    ] {
        assert!(
            Action::parse(forbidden).is_err(),
            "\"{forbidden}\" must not be an action"
        );
    }
}

#[test]
fn unknown_protocol_version_is_rejected() {
    let args = ActionArgs::AgentsDelete(AgentsDeleteArgs {
        target: AgentTarget::Pubkey(pubkey()),
    });

    for bad in [0_u16, 2, 999] {
        let mut request = BrokerRequest::new("req-1", args.clone()).unwrap();
        request.protocol_version = bad;
        let error = request.validate().unwrap_err().to_string();
        assert!(error.contains("protocolVersion"), "unexpected: {error}");

        let mut response = BrokerResponse::new(
            "req-1",
            BrokerResult::failed(BrokerError::unsupported("no")),
        );
        response.protocol_version = bad;
        assert!(response.validate().is_err());
    }
}

#[test]
fn unknown_action_version_is_rejected() {
    let mut request = BrokerRequest::new(
        "req-1",
        ActionArgs::AgentsDelete(AgentsDeleteArgs {
            target: AgentTarget::Pubkey(pubkey()),
        }),
    )
    .unwrap();
    request.action_version = 7;
    let error = request.validate().unwrap_err().to_string();
    assert!(error.contains("actionVersion"), "unexpected: {error}");
}

#[test]
fn wrong_type_discriminator_is_rejected() {
    let mut request = BrokerRequest::new(
        "req-1",
        ActionArgs::AgentsDelete(AgentsDeleteArgs {
            target: AgentTarget::Pubkey(pubkey()),
        }),
    )
    .unwrap();
    request.r#type = BROKER_RESULT_TYPE.into();
    assert!(request.validate().is_err());

    let mut response = BrokerResponse::new(
        "req-1",
        BrokerResult::failed(BrokerError::unsupported("no")),
    );
    response.r#type = BROKER_REQUEST_TYPE.into();
    assert!(response.validate().is_err());
}

#[test]
fn request_id_must_be_present_bounded_and_printable() {
    let args = || {
        ActionArgs::AgentsDelete(AgentsDeleteArgs {
            target: AgentTarget::Pubkey(pubkey()),
        })
    };
    assert!(BrokerRequest::new("", args()).is_err());
    assert!(BrokerRequest::new("a".repeat(MAX_REQUEST_ID_LEN), args()).is_ok());
    assert!(BrokerRequest::new("a".repeat(MAX_REQUEST_ID_LEN + 1), args()).is_err());
    assert!(BrokerRequest::new("has space", args()).is_err());
    assert!(BrokerRequest::new("has\nnewline", args()).is_err());
    assert!(BrokerRequest::new("has\u{7f}del", args()).is_err());
    assert!(BrokerRequest::new("req/1-a.b:c", args()).is_ok());
}

/// The envelope must not carry requester, owner, or scope: those are derived by
/// the host from the credential. A body that could name its own subject would
/// let any caller act as anyone.
#[test]
fn request_carries_no_caller_supplied_authority() {
    let json = serde_json::to_value(
        BrokerRequest::new(
            "req-1",
            ActionArgs::ChannelRead(ChannelReadArgs::channel(CHANNEL)),
        )
        .unwrap(),
    )
    .unwrap();
    let object = json.as_object().unwrap();

    for forbidden in [
        "ownerPubkey",
        "owner",
        "requesterPubkey",
        "requester",
        "agentPubkey",
        "authorization",
        "credential",
        "token",
        "scope",
        "expiry",
        "relayUrl",
        "requestDigest",
    ] {
        assert!(
            !object.contains_key(forbidden),
            "broker request must not carry \"{forbidden}\""
        );
    }

    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "action",
            "actionVersion",
            "args",
            "protocolVersion",
            "requestId",
            "type",
        ]
    );
}

/// `agents.create` must not let a request name its own authority: ownership is
/// the authenticated requester, which is why there is no field for it.
#[test]
fn agents_create_has_no_owner_field() {
    let json = serde_json::to_value(AgentsCreateArgs {
        channel_id: CHANNEL.into(),
        display_name: "A".into(),
        system_prompt: "B".into(),
        runtime: None,
        provider: None,
        model: None,
        respond_to: None,
    })
    .unwrap();
    for forbidden in ["owner", "ownerPubkey", "createdBy", "onBehalfOf"] {
        assert!(json.get(forbidden).is_none());
    }

    let with_owner = serde_json::json!({
        "channelId": CHANNEL,
        "displayName": "A",
        "systemPrompt": "B",
        "ownerPubkey": PUBKEY,
    });
    assert!(serde_json::from_value::<AgentsCreateArgs>(with_owner).is_err());
}

// ── The no-secret invariant ─────────────────────────────────────────────────

/// No type in this contract may name, hold, or accept secret key material.
///
/// Scanning the source is the load-bearing half of this invariant: a
/// deserialization test can only reject fields someone thought to add, while
/// this fails the moment a secret-key type appears in a signature at all.
#[test]
fn no_secret_key_type_appears_in_the_contract_source() {
    // `tests.rs` is excluded: this file necessarily names the forbidden tokens.
    let sources = [
        ("mod.rs", include_str!("mod.rs")),
        ("actions.rs", include_str!("actions.rs")),
        ("client.rs", include_str!("client.rs")),
    ];
    // Substrings, so `Option<SecretKey>` and `nostr::Keys` are caught too.
    let forbidden = [
        "SecretKey",
        "nostr::Keys",
        "Keys::",
        "secret_key",
        "seckey",
        "private_key",
        "nsec1",
        "sign_event",
        "ConversationKey",
    ];

    for (name, source) in sources {
        for token in forbidden {
            for (index, line) in source.lines().enumerate() {
                // Doc comments may discuss what is absent and why.
                let code = line.trim_start();
                if code.starts_with("//") {
                    continue;
                }
                assert!(
                    !code.contains(token),
                    "{name}:{} names \"{token}\" in code: {code}",
                    index + 1
                );
            }
        }
    }
}

/// A secret smuggled into args must fail to deserialize rather than reach an
/// executor.
#[test]
fn secret_bearing_args_fail_to_deserialize() {
    let smuggled = [
        serde_json::json!({
            "channelId": CHANNEL,
            "displayName": "Sneaky",
            "systemPrompt": "hi",
            "envVars": { "ANTHROPIC_API_KEY": "sk-live" },
        }),
        serde_json::json!({
            "channelId": CHANNEL,
            "displayName": "Sneaky",
            "systemPrompt": "hi",
            "secretKey": "nsec1deadbeef",
        }),
        serde_json::json!({
            "channelId": CHANNEL,
            "displayName": "Sneaky",
            "systemPrompt": "hi",
            "privateKey": "hexsecret",
        }),
    ];
    for args in smuggled {
        assert!(
            serde_json::from_value::<AgentsCreateArgs>(args.clone()).is_err(),
            "must reject: {args}"
        );
    }
}

/// An outcome must be structurally unable to carry secret material, including
/// the freshly minted key of an agent it just created.
#[test]
fn outcomes_cannot_carry_secrets() {
    for extra in [
        "privateKeyNsec",
        "nsec",
        "secretKey",
        "seckey",
        "credential",
    ] {
        let mut outcome = serde_json::json!({
            "agentPubkey": PUBKEY,
            "displayName": "A",
            "channelId": CHANNEL,
        });
        outcome[extra] = serde_json::json!("nsec1deadbeef");
        let json = serde_json::json!({ "action": "agents.create", "outcome": outcome });
        assert!(
            serde_json::from_value::<ActionOutcome>(json).is_err(),
            "an outcome carrying \"{extra}\" must not deserialize"
        );
    }
}

/// A `storage.address` outcome carries addressing material only — never the key
/// that derived it.
#[test]
fn storage_address_outcome_carries_addressing_only() {
    let json = serde_json::to_value(StorageAddress {
        author_pubkey: pubkey(),
        kind: 30174,
        d_tag: EVENT.into(),
    })
    .unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["authorPubkey", "dTag", "kind"]);
}

#[test]
fn pubkey_hex_rejects_anything_but_a_public_key() {
    assert!(PubkeyHex::parse("nothex").is_err());
    assert!(PubkeyHex::parse(&PUBKEY[..40]).is_err());
    assert!(PubkeyHex::parse(format!("{PUBKEY}00")).is_err());
    assert!(PubkeyHex::parse("nsec1deadbeef").is_err());
    // Normalizes case, so two spellings of one key cannot look like two keys.
    assert_eq!(
        PubkeyHex::parse(PUBKEY.to_ascii_uppercase()).unwrap(),
        pubkey()
    );
    // And it enforces that through serde, not only through the constructor.
    assert!(serde_json::from_value::<PubkeyHex>(serde_json::json!("nothex")).is_err());
}

// ── Argument validation ─────────────────────────────────────────────────────

#[test]
fn every_fixture_validates_and_normalization_is_idempotent() {
    for args in action_fixtures() {
        let once = args.validated().expect("fixture validates");
        let twice = once.validated().expect("normalized form validates");
        assert_eq!(
            once,
            twice,
            "{} normalization must settle",
            args.action().as_str()
        );
    }
}

#[test]
fn reads_reject_a_bad_channel_thread_or_limit() {
    assert!(ChannelReadArgs::channel("not-a-uuid").validated().is_err());
    assert!(ChannelReadArgs::channel(CHANNEL)
        .in_thread("nothex")
        .validated()
        .is_err());
    assert!(ChannelReadArgs::channel(CHANNEL)
        .limit(0)
        .validated()
        .is_err());
    assert!(ChannelReadArgs::channel(CHANNEL)
        .limit(actions::MAX_PAGE_LIMIT)
        .validated()
        .is_ok());
    assert!(ChannelReadArgs::channel(CHANNEL)
        .limit(actions::MAX_PAGE_LIMIT + 1)
        .validated()
        .is_err());
}

/// A bare channel read must not imply a thread or a mention filter the caller
/// never asked for.
#[test]
fn a_bare_channel_read_carries_no_unset_narrowing() {
    let json = serde_json::to_value(ChannelReadArgs::channel(CHANNEL)).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["channelId"]);
}

#[test]
fn writes_reject_empty_oversized_and_over_mentioned_content() {
    let post = |content: String, mentions: Vec<PubkeyHex>| MessagePostArgs {
        channel_id: CHANNEL.into(),
        content,
        mentions,
    };
    assert!(post("   ".into(), vec![]).validated().is_err());
    assert!(matches!(
        post("x".repeat(actions::MAX_CONTENT_BYTES + 1), vec![])
            .validated()
            .unwrap_err(),
        SdkError::ContentTooLarge { .. }
    ));
    assert!(matches!(
        post("hi".into(), vec![pubkey(); actions::MAX_MENTIONS + 1])
            .validated()
            .unwrap_err(),
        SdkError::TooManyMentions
    ));
    assert!(post("hi".into(), vec![pubkey(); actions::MAX_MENTIONS])
        .validated()
        .is_ok());
}

#[test]
fn reaction_rejects_empty_and_oversized_payloads() {
    let react = |reaction: String| ReactionAddArgs {
        channel_id: CHANNEL.into(),
        target_event_id: EVENT.into(),
        reaction,
    };
    assert!(react(" ".into()).validated().is_err());
    assert!(matches!(
        react("a".repeat(actions::MAX_EMOJI_CHARS + 1))
            .validated()
            .unwrap_err(),
        SdkError::EmojiTooLong
    ));
    assert!(react(":shipit:".into()).validated().is_ok());
}

#[test]
fn profile_set_requires_a_change_and_names_no_subject() {
    let empty = ProfileSetArgs {
        display_name: None,
        about: None,
        picture: None,
    };
    let error = empty.validated().unwrap_err().to_string();
    assert!(error.contains("at least one"), "unexpected: {error}");

    let with_subject = serde_json::json!({ "displayName": "A", "pubkey": PUBKEY });
    assert!(serde_json::from_value::<ProfileSetArgs>(with_subject).is_err());
}

#[test]
fn storage_address_enforces_the_nip_ae_slug_grammar() {
    let slug = |slug: &str| StorageAddressArgs { slug: slug.into() }.validated();
    assert!(slug("core").is_ok());
    assert!(slug("mem/broker-foundation").is_ok());
    assert!(slug("").is_err());
    assert!(slug("Core").is_err());
    assert!(slug("secrets").is_err());
    assert!(slug("mem/Bad Slug").is_err());
}

#[test]
fn agent_update_requires_a_change_and_delete_requires_a_target() {
    let empty = AgentsUpdateArgs {
        target: AgentTarget::Pubkey(pubkey()),
        display_name: None,
        system_prompt: None,
        runtime: None,
        provider: None,
        model: None,
        respond_to: None,
    };
    let error = empty.validated().unwrap_err().to_string();
    assert!(error.contains("at least one field"), "unexpected: {error}");

    assert!(AgentsDeleteArgs {
        target: AgentTarget::Name("  ".into()),
    }
    .validated()
    .is_err());
}

#[test]
fn agents_create_rejects_an_unsupported_respond_to_mode() {
    let args = AgentsCreateArgs {
        channel_id: CHANNEL.into(),
        display_name: "A".into(),
        system_prompt: "B".into(),
        runtime: None,
        provider: None,
        model: None,
        respond_to: Some("allowlist".into()),
    };
    assert!(args.validated().is_err());
}

/// Update and delete carry no channel: channel appears only where the operation
/// needs it, which is the create attachment.
#[test]
fn agent_update_and_delete_carry_no_channel() {
    let update = serde_json::to_value(AgentsUpdateArgs {
        target: AgentTarget::Pubkey(pubkey()),
        display_name: Some("New".into()),
        system_prompt: None,
        runtime: None,
        provider: None,
        model: None,
        respond_to: None,
    })
    .unwrap();
    assert!(update.get("channelId").is_none());

    let delete = serde_json::to_value(AgentsDeleteArgs {
        target: AgentTarget::Name("Gone".into()),
    })
    .unwrap();
    assert!(delete.get("channelId").is_none());
}

// ── Results ─────────────────────────────────────────────────────────────────

#[test]
fn failed_and_indeterminate_are_distinct_and_carry_no_outcome() {
    let failed = BrokerResult::failed(BrokerError::new(
        BrokerErrorCode::ActionFailed,
        "runtime not installed",
    ));
    let failed_json = serde_json::to_value(BrokerResponse::new("r", failed.clone())).unwrap();
    assert_eq!(failed_json["status"], "failed");
    assert_eq!(failed_json["error"]["code"], "action_failed");
    assert!(failed_json.get("outcome").is_none());

    let indeterminate = BrokerResult::indeterminate(BrokerError::new(
        BrokerErrorCode::OutcomeUnknown,
        "host restarted mid-execution",
    ));
    let json = serde_json::to_value(BrokerResponse::new("r", indeterminate.clone())).unwrap();
    assert_eq!(json["status"], "indeterminate");
    assert_eq!(json["error"]["code"], "outcome_unknown");
    assert!(json.get("outcome").is_none());

    assert_ne!(failed, indeterminate);
    assert!(failed.outcome().is_none());
    assert!(indeterminate.outcome().is_none());
}

#[test]
fn replay_metadata_rides_the_response_not_the_result() {
    let result = BrokerResult::succeeded(ActionOutcome::AgentsDelete(AgentsDeleteOutcome {
        agent_pubkey: pubkey(),
        display_name: "Gone".into(),
    }));
    let fresh = BrokerResponse::new("req-9", result.clone());
    let replayed = BrokerResponse::new("req-9", result.clone()).replayed();

    // The domain outcome is identical; only the delivery metadata differs.
    assert_eq!(fresh.result, replayed.result);
    assert!(!fresh.replayed);
    assert!(replayed.replayed);
    assert_eq!(
        serde_json::to_value(&replayed).unwrap()["replayed"],
        serde_json::json!(true)
    );

    // `replayed` is not part of the stored result encoding.
    assert!(serde_json::to_value(&result)
        .unwrap()
        .get("replayed")
        .is_none());
}

#[test]
fn every_error_code_has_a_stable_wire_string() {
    for (code, expected) in [
        (BrokerErrorCode::InvalidRequest, "invalid_request"),
        (
            BrokerErrorCode::UnsupportedProtocolVersion,
            "unsupported_protocol_version",
        ),
        (BrokerErrorCode::UnknownAction, "unknown_action"),
        (
            BrokerErrorCode::UnsupportedActionVersion,
            "unsupported_action_version",
        ),
        (BrokerErrorCode::Unsupported, "unsupported"),
        (BrokerErrorCode::Unauthenticated, "unauthenticated"),
        (BrokerErrorCode::Unauthorized, "unauthorized"),
        (BrokerErrorCode::RequestIdConflict, "request_id_conflict"),
        (BrokerErrorCode::ActionFailed, "action_failed"),
        (BrokerErrorCode::OutcomeUnknown, "outcome_unknown"),
        (BrokerErrorCode::Internal, "internal"),
    ] {
        assert_eq!(code.as_str(), expected);
        assert_eq!(
            serde_json::to_value(code).unwrap(),
            serde_json::json!(expected)
        );
    }
}

/// Only housekeeping is best-effort. A host refusing a read or a write has
/// broken the agent, and the agent must not treat that as routine.
#[test]
fn only_housekeeping_actions_are_best_effort() {
    assert!(Action::ReactionAdd.is_best_effort());
    for essential in [
        Action::ChannelRead,
        Action::MessagePost,
        Action::MessageReply,
        Action::ProfileSet,
        Action::StorageAddress,
        Action::AgentsCreate,
        Action::AgentsUpdate,
        Action::AgentsDelete,
    ] {
        assert!(
            !essential.is_best_effort(),
            "{} must not be best-effort",
            essential.as_str()
        );
    }
}

// ── Client trait ────────────────────────────────────────────────────────────

/// A test double, and the only implementation in this crate. It exists to prove
/// the trait is object-safe and usable behind `dyn`, which is what lets an
/// in-process host and an HTTP client be interchangeable.
struct DoubleBroker {
    response: Result<BrokerResponse, BrokerTransportError>,
}

impl BrokerClient for DoubleBroker {
    fn execute<'a>(&'a self, request: &'a BrokerRequest) -> BrokerFuture<'a> {
        let response = self.response.clone().map(|mut response| {
            response.request_id = request.request_id.clone();
            response
        });
        Box::pin(async move { response })
    }
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    // A hand-rolled park-free executor: the double's future is always ready, so
    // one poll suffices and pulling in a runtime would be the heavier choice.
    use std::task::{Context, Poll, Wake, Waker};
    struct NoopWake;
    impl Wake for NoopWake {
        fn wake(self: std::sync::Arc<Self>) {}
    }
    let waker = Waker::from(std::sync::Arc::new(NoopWake));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    match future.as_mut().poll(&mut context) {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("test double must not park"),
    }
}

#[test]
fn the_client_trait_is_object_safe_and_returns_a_host_verdict() {
    let request = BrokerRequest::new(
        "req-42",
        ActionArgs::ChannelRead(ChannelReadArgs::channel(CHANNEL).mentions_only()),
    )
    .unwrap();

    let succeeded: Box<dyn BrokerClient> = Box::new(DoubleBroker {
        response: Ok(BrokerResponse::new(
            "placeholder",
            BrokerResult::succeeded(ActionOutcome::ChannelRead(MessagePage {
                messages: vec![],
                next_cursor: None,
            })),
        )),
    });
    let response = block_on(succeeded.execute(&request)).expect("double answers");
    response.validate().expect("double's response is valid");
    assert_eq!(response.request_id, "req-42");
    assert!(response.result.outcome().is_some());

    // A refusal is still an answer: `Ok` with the verdict in the envelope.
    let refused: Box<dyn BrokerClient> = Box::new(DoubleBroker {
        response: Ok(BrokerResponse::new(
            "placeholder",
            BrokerResult::failed(BrokerError::unauthorized("not your channel")),
        )),
    });
    let response = block_on(refused.execute(&request)).expect("a refusal is not a transport error");
    assert_eq!(
        response.result.error().map(|e| e.code),
        Some(BrokerErrorCode::Unauthorized)
    );

    // No answer at all is a transport error, and says nothing about side effects.
    let unreachable: Box<dyn BrokerClient> = Box::new(DoubleBroker {
        response: Err(BrokerTransportError::CredentialRejected),
    });
    assert_eq!(
        block_on(unreachable.execute(&request)).unwrap_err(),
        BrokerTransportError::CredentialRejected
    );
}

#[test]
fn the_http_binding_is_a_single_path_with_a_bearer_credential() {
    assert_eq!(BROKER_ACTION_PATH, "/v1/action");
    assert_eq!(BROKER_CREDENTIAL_HEADER, "authorization");
}

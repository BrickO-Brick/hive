use super::*;

#[test]
fn relay_auth_errors_preserve_stable_codes_for_ui_mapping() {
    for (code, message) in [
        ("room_full", "room participant capacity reached"),
        ("room_ended", "huddle has ended"),
        ("huddle_relay_draining", "relay is draining; reconnect"),
        (
            "huddle_owner_unreachable",
            "could not reach the huddle owner",
        ),
        ("unsupported_version", "unsupported audio protocol version"),
        ("upgrade_required", "audio protocol upgrade required"),
    ] {
        let payload = serde_json::json!({
            "type": "error",
            "code": code,
            "message": message,
        });
        let error = format_audio_relay_error(&payload);
        assert_eq!(error.code(), Some(code));
        assert_eq!(
            error.to_string(),
            format!("audio relay auth error [{code}]: {message}")
        );
    }
}

#[test]
fn audio_send_queue_drops_oldest_frame_when_full() {
    let queue = AudioSendQueue::default();
    for value in 0..=AUDIO_SEND_QUEUE_DEPTH as u8 {
        queue.push_latest(vec![value]);
    }
    let frames = queue
        .state
        .lock()
        .expect("queue")
        .frames
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(frames, vec![vec![1], vec![2], vec![3], vec![4]]);
}

#[tokio::test]
async fn audio_send_queue_close_wakes_waiter_and_rejects_new_frames() {
    let queue = std::sync::Arc::new(AudioSendQueue::default());
    let waiting_queue = std::sync::Arc::clone(&queue);
    let waiter = tokio::spawn(async move { waiting_queue.pop().await });
    tokio::task::yield_now().await;

    queue.close();
    assert_eq!(waiter.await.expect("waiter"), None);
    queue.push_latest(vec![1]);
    assert_eq!(queue.pop().await, None);
}

#[tokio::test]
async fn audio_send_queue_drains_before_reporting_closed() {
    let queue = AudioSendQueue::default();
    queue.push_latest(vec![1]);
    queue.close();

    assert_eq!(queue.pop().await, Some(vec![1]));
    assert_eq!(queue.pop().await, None);
}

#[tokio::test]
async fn wire_send_failure_is_preserved_for_pipeline_owner() {
    struct FailingSink;
    impl futures_util::Sink<WsMsg> for FailingSink {
        type Error = &'static str;

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Err("socket closed"))
        }
        fn start_send(self: std::pin::Pin<&mut Self>, _item: WsMsg) -> Result<(), Self::Error> {
            Err("socket closed")
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    let queue = std::sync::Arc::new(AudioSendQueue::default());
    queue.push_latest(vec![1]);
    let result = wire_send_loop(
        queue,
        std::sync::Arc::new(tokio::sync::Mutex::new(FailingSink)),
    )
    .await;
    assert!(
        result.is_err_and(|error| error == "audio send: socket closed"),
        "the reconnect owner must receive the socket send failure"
    );
}

#[test]
fn authenticated_roster_parsing_preserves_only_authoritative_publisher_roles() {
    let publisher = serde_json::json!({
        "peer_index": 7,
        "pubkey": "agent",
        "epoch": 3,
        "role": "AgentTtsPublisher",
    });
    assert_eq!(
        parse_audio_roster_peer(&publisher),
        Some((7, "agent".to_string(), 3, true))
    );

    let participant = serde_json::json!({
        "peer_index": 8,
        "pubkey": "human",
        "role": "Participant",
    });
    assert_eq!(
        parse_audio_roster_peer(&participant),
        Some((8, "human".to_string(), 0, false))
    );

    let overflowing_index = serde_json::json!({
        "peer_index": 256,
        "pubkey": "invalid",
        "role": "AgentTtsPublisher",
    });
    assert_eq!(parse_audio_roster_peer(&overflowing_index), None);
}

#[test]
fn duplicate_identity_is_a_typed_lost_election() {
    let error = format_audio_relay_error(&serde_json::json!({
        "code": "duplicate_identity",
        "message": "publisher already connected",
    }));
    assert!(error.is_lost_election());

    let other = format_audio_relay_error(&serde_json::json!({
        "code": "not_member",
        "message": "membership required",
    }));
    assert!(!other.is_lost_election());
}

#[test]
fn tts_upsampling_doubles_rate_with_linear_midpoints() {
    assert_eq!(
        upsample_tts_24k_to_48k(&[0.0, 1.0, -1.0]),
        vec![0.0, 0.5, 1.0, 0.0, -1.0, -1.0]
    );
}

#[test]
fn tts_queue_rejects_cancelled_versions_and_pads_twenty_ms_frames() {
    let mut queue = std::collections::VecDeque::new();
    queue_tts_broadcast_packet(
        &mut queue,
        super::super::tts::TtsBroadcastPacket {
            epoch: 1,
            speaker_generation: 7,
            samples_24k: vec![0.25; 480],
        },
        1,
        7,
    );
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].samples_48k.len(), 960);

    queue_tts_broadcast_packet(
        &mut queue,
        super::super::tts::TtsBroadcastPacket {
            epoch: 1,
            speaker_generation: 7,
            samples_24k: vec![0.5; 480],
        },
        2,
        7,
    );
    assert_eq!(queue.len(), 1, "cancelled epoch must not enqueue");
}

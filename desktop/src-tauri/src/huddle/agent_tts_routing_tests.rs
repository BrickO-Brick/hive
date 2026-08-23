use super::{
    classify_agent_tts_runtime, enqueue_agent_tts_text, normalize_agent_tts_text,
    remote_agent_publisher_is_live, AgentTtsRuntimeGate, MAX_TTS_TEXT_LEN,
};
use crate::huddle::HuddlePhase;

#[tokio::test]
async fn assistant_plain_text_routes_unchanged_into_voice_pipeline_boundary() {
    let (sender, receiver) = std::sync::mpsc::channel();
    let text = "A newly submitted assistant reply.".to_string();
    let route_id = 42;

    enqueue_agent_tts_text(route_id, text.clone(), move |route_id, queued| {
        sender
            .send((route_id, queued))
            .map_err(|error| error.to_string())
    })
    .await
    .expect("route assistant text");

    assert_eq!(
        receiver.recv().expect("queued text"),
        (route_id, text),
        "route correlation must survive the native queue boundary"
    );
}

#[test]
fn disabled_is_the_only_intentional_runtime_no_op() {
    assert_eq!(
        classify_agent_tts_runtime(false, &HuddlePhase::Connected, false),
        AgentTtsRuntimeGate::Disabled
    );
    assert_eq!(
        classify_agent_tts_runtime(true, &HuddlePhase::Idle, false),
        AgentTtsRuntimeGate::Inactive
    );
    assert_eq!(
        classify_agent_tts_runtime(true, &HuddlePhase::Connected, false),
        AgentTtsRuntimeGate::NeedsPipeline
    );
    assert_eq!(
        classify_agent_tts_runtime(true, &HuddlePhase::Connected, true),
        AgentTtsRuntimeGate::Ready
    );
}

#[test]
fn live_remote_agent_publisher_suppresses_only_that_agents_local_fallback() {
    let peers = ["human", "AGENT-A", "agent-b"];
    assert!(remote_agent_publisher_is_live("agent-a", peers));
    assert!(!remote_agent_publisher_is_live("agent-c", peers));
    assert!(!remote_agent_publisher_is_live(
        "agent-a",
        std::iter::empty::<&str>(),
    ));
}

#[test]
fn assistant_text_truncation_is_unicode_safe_before_voice_routing() {
    assert_eq!(MAX_TTS_TEXT_LEN, 8_096);
    let input = "🦀".repeat(MAX_TTS_TEXT_LEN + 1);
    let output = normalize_agent_tts_text(input);
    assert_eq!(
        output.chars().count(),
        MAX_TTS_TEXT_LEN + "... message truncated.".chars().count()
    );
    assert!(output.ends_with("... message truncated."));
}

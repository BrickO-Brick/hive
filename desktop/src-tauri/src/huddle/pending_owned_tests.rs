//! Tests for the huddle channel pending-owned overlay lifecycle
//! (`start_huddle` mark → `clear_pending_owned_huddle_channel`).

use super::clear_pending_owned_huddle_channel;

/// `start_huddle` marks the ephemeral channel pending-owned under the
/// signing identity so the huddle window's member-only channel poll
/// resolves it before relay kind:39002 membership propagates; the end
/// helper removes exactly that entry.
#[test]
fn end_clears_the_pending_owned_mark_for_the_signing_identity() {
    let state = crate::app_state::build_app_state();
    let my_pubkey = state
        .signing_keys()
        .expect("signable")
        .public_key()
        .to_hex();
    let channel_id = "11111111-2222-3333-4444-555555555555";

    state.mark_pending_owned_channel(&my_pubkey, channel_id);
    assert!(state.is_pending_owned_channel(&my_pubkey, channel_id));

    clear_pending_owned_huddle_channel(&state, channel_id);
    assert!(!state.is_pending_owned_channel(&my_pubkey, channel_id));
}

/// In recovery mode (`identity_lost`) there is no signable identity; the
/// clear helper must be a no-op rather than an error or panic, and the
/// original identity's entry must survive untouched.
#[test]
fn clear_is_a_noop_without_a_signable_identity() {
    let state = crate::app_state::build_app_state();
    let my_pubkey = state
        .signing_keys()
        .expect("signable")
        .public_key()
        .to_hex();
    let channel_id = "11111111-2222-3333-4444-555555555555";
    state.mark_pending_owned_channel(&my_pubkey, channel_id);

    state
        .identity_lost
        .store(true, std::sync::atomic::Ordering::Release);
    clear_pending_owned_huddle_channel(&state, channel_id);

    assert!(state.is_pending_owned_channel(&my_pubkey, channel_id));
}

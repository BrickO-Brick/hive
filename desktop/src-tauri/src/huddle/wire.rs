//! Huddle audio wire protocol — versioning + frame header.
//!
//! ## v1 (legacy)
//!
//! Client → relay: `<opus_bytes>`
//! Relay   → client: `<peer_index: u8><opus_bytes>`
//!
//! No per-frame metadata; receiver synthesizes sequence/timestamp on arrival.
//! Kept for backward compatibility — relay still admits v1 clients into
//! v1-pinned rooms — but new clients always speak v3.
//!
//! ## v2 (released)
//!
//! Client → relay: `<header: [u8; 8]><opus_bytes>`
//! Relay   → client: `<peer_index: u8><header: [u8; 8]><opus_bytes>`
//!
//! ## v3 (this commit)
//!
//! Client → relay: `<header: [u8; 8]><opus_bytes>`
//! Relay   → client: `<peer_index: u8><epoch: u8><header: [u8; 8]><opus_bytes>`
//!
//! The relay prefixes each forwarded frame with the sender's stable
//! `peer_index` and the current occupancy `epoch` of that index. The epoch
//! advances each time a slot is reused by a new occupant, so a client can
//! fence a frame authored by a departed occupant that arrives after its index
//! is reassigned — it carries the stale epoch and is dropped rather than
//! mis-attributed. The client's own send path is unaffected: it emits only
//! `<header><opus_bytes>` and the relay stamps the prefix.
//!
//! The 8-byte header codec itself lives in `buzz_core::huddle_wire`, shared
//! with the relay. Negotiation lives in the WS auth message
//! (`protocol_version: 3`), not in any header bit; mixed-version rooms are
//! rejected at the relay with `upgrade_required`.

/// Wire protocol version this client speaks. Bumped only when the frame
/// layout itself changes; the relay tracks pinned per-room.
pub const PROTOCOL_VERSION: u8 = 3;

// The header codec is shared with the relay so the two ends cannot drift.
pub use buzz_core_pkg::huddle_wire::{FrameHeader, FLAG_DTX, V2_HEADER_LEN};

/// Compute a dBov audio level for a normalized f32 PCM frame.
///
/// "dBov" is RMS expressed in dB relative to full scale (where full scale =
/// peak amplitude 1.0), clamped into the v2 header's canonical `-127..=0`
/// range. A silent frame returns `-127`; full-scale ±1.0 returns `0`.
///
/// This is cheap (one pass over the samples, one log) and runs once per
/// 20 ms frame, so it's nowhere near the audio fast-path budget.
pub fn audio_level_dbov(samples: &[f32]) -> i8 {
    if samples.is_empty() {
        return -127;
    }
    let mean_square: f64 = samples
        .iter()
        .map(|&s| {
            let v = s as f64;
            v * v
        })
        .sum::<f64>()
        / samples.len() as f64;
    if mean_square <= 0.0 {
        return -127;
    }
    let rms = mean_square.sqrt();
    let db = 20.0 * rms.log10();
    // Clamp into the canonical range. -127 = silence floor, 0 = full scale.
    if !db.is_finite() || db <= -127.0 {
        -127
    } else if db >= 0.0 {
        0
    } else {
        db.round() as i8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_level_dbov_clamps_silence_to_minus_127() {
        assert_eq!(audio_level_dbov(&[]), -127);
        assert_eq!(audio_level_dbov(&[0.0_f32; 960]), -127);
    }

    #[test]
    fn audio_level_dbov_full_scale_returns_zero() {
        let frame: Vec<f32> = (0..960).map(|_| 1.0_f32).collect();
        assert_eq!(audio_level_dbov(&frame), 0);
    }

    #[test]
    fn audio_level_dbov_is_in_canonical_range_for_realistic_speech() {
        // A 1 kHz sine at amplitude 0.3 — typical normalized speech peak.
        // RMS ≈ 0.3 / sqrt(2) ≈ 0.212 → ≈ -13 dBov.
        let frame: Vec<f32> = (0..960)
            .map(|i| {
                let t = i as f32 / 48_000.0;
                0.3 * (2.0 * std::f32::consts::PI * 1_000.0 * t).sin()
            })
            .collect();
        let db = audio_level_dbov(&frame);
        assert!(
            (-20..=-8).contains(&db),
            "expected -20..=-8 dBov for 0.3-amp sine, got {db}",
        );
    }
}

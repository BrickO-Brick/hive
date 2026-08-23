//! Huddle audio frame header — the half of the wire protocol both ends share.
//!
//! Clients author an 8-byte header in front of every Opus packet; the relay
//! parses it for telemetry and forwards the bytes opaquely, prefixing its own
//! routing metadata (`[peer_index]` in v2, `[peer_index][epoch]` in v3). The
//! header layout is identical across v2 and v3 — only the relay prefix grew —
//! so one codec serves both sides of the protocol.
//!
//! Layout (network byte order):
//!
//! ```text
//!  byte 0..=1 : seq         u16  wrapping sequence number, +1 per packet
//!  byte 2..=5 : ts_48k      u32  sender RTP-style 48 kHz media time,
//!                                +960 per 20 ms encoded frame
//!  byte 6     : level_dbov  i8   audio level in dBov, range [-127, 0]
//!  byte 7     : flags       u8   bit 0 = DTX/comfort frame; other bits
//!                                MUST be ignored on decode
//! ```
//!
//! # Threat-model invariant
//!
//! `level_dbov` is client-authored telemetry. Anything built on it (logs,
//! active-speaker hints, dominant-talker decisions) must treat it as
//! untrusted. [`FrameHeader::parse`] clamps out-of-range values into
//! `-127..=0` but never rejects the frame for bad VU data — bad metadata must
//! not become audible loss. Trust decisions (admission, moderation, kicks)
//! MUST NOT consume `level_dbov`.

/// Length of the per-frame header in bytes.
pub const V2_HEADER_LEN: usize = 8;

/// Flag bit marking a DTX / comfort-noise frame. Encoders MUST set it for any
/// Opus packet they tag as DTX; receivers MAY skip arrival accounting for it.
pub const FLAG_DTX: u8 = 0x01;

/// Every flag bit that is not yet assigned. Receivers MUST ignore these; they
/// are available to the next minor protocol bump without a version change.
pub const RESERVED_FLAG_MASK: u8 = !FLAG_DTX;

/// Parsed view of one frame header. Cheap (`Copy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    /// Sender-authored sequence number; wraps every 2^16 frames (~21.8 min
    /// at 50 Hz).
    pub seq: u16,
    /// Sender-authored 48 kHz RTP-style media timestamp.
    pub ts_48k: u32,
    /// Audio level in dBov, always within the canonical `-127..=0` after
    /// parsing. Untrusted; diagnostics only.
    pub level_dbov: i8,
    /// Raw flags byte. Test with [`FLAG_DTX`] / [`Self::is_dtx`]; reserved
    /// bits pass through untouched.
    pub flags: u8,
}

impl FrameHeader {
    /// Encode into 8 bytes, network byte order, ready to prepend to an Opus
    /// payload.
    pub fn encode(self) -> [u8; V2_HEADER_LEN] {
        let mut out = [0u8; V2_HEADER_LEN];
        out[0..2].copy_from_slice(&self.seq.to_be_bytes());
        out[2..6].copy_from_slice(&self.ts_48k.to_be_bytes());
        out[6] = self.level_dbov as u8;
        out[7] = self.flags;
        out
    }

    /// Parse the header from the leading 8 bytes of `bytes`, returning it with
    /// the remaining payload (the opaque Opus body). `None` means the frame is
    /// too short to carry a header and should be dropped as malformed.
    ///
    /// `level_dbov` outside `-127..=0` is clamped to `-127` (the silence
    /// floor); the frame itself is never rejected for bad telemetry.
    pub fn parse(bytes: &[u8]) -> Option<(Self, &[u8])> {
        if bytes.len() < V2_HEADER_LEN {
            return None;
        }
        let seq = u16::from_be_bytes([bytes[0], bytes[1]]);
        let ts_48k = u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]);
        let raw_level = bytes[6] as i8;
        let level_dbov = if (-127..=0).contains(&raw_level) {
            raw_level
        } else {
            -127
        };
        let flags = bytes[7];
        Some((
            Self {
                seq,
                ts_48k,
                level_dbov,
                flags,
            },
            &bytes[V2_HEADER_LEN..],
        ))
    }

    /// True if [`FLAG_DTX`] is set.
    pub fn is_dtx(&self) -> bool {
        (self.flags & FLAG_DTX) != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_fields() {
        let h = FrameHeader {
            seq: 0xABCD,
            ts_48k: 0x12_34_56_78,
            level_dbov: -40,
            flags: FLAG_DTX,
        };
        let bytes = h.encode();
        let (parsed, tail) = FrameHeader::parse(&bytes).expect("parse");
        assert_eq!(parsed, h);
        assert!(tail.is_empty());
        assert!(parsed.is_dtx());
    }

    /// Pins the byte layout so an endianness slip on either side of the
    /// protocol is caught immediately.
    #[test]
    fn encoded_byte_order_is_network_byte_order() {
        let bytes = FrameHeader {
            seq: 0x0102,
            ts_48k: 0x0304_0506,
            level_dbov: -1,
            flags: 0,
        }
        .encode();
        assert_eq!(bytes, [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xFF, 0x00]);
        let (h, _) = FrameHeader::parse(&bytes).expect("parse");
        assert_eq!((h.seq, h.ts_48k, h.level_dbov), (0x0102, 0x0304_0506, -1));
    }

    #[test]
    fn parse_rejects_short_input() {
        for len in 0..V2_HEADER_LEN {
            assert!(
                FrameHeader::parse(&vec![0u8; len]).is_none(),
                "{len} bytes must be rejected"
            );
        }
    }

    /// The remainder is exactly what a receiver hands to the Opus decoder and
    /// what the relay forwards.
    #[test]
    fn parse_returns_payload_remainder() {
        let mut buf = FrameHeader {
            seq: 1,
            ts_48k: 960,
            level_dbov: -20,
            flags: 0,
        }
        .encode()
        .to_vec();
        buf.extend_from_slice(b"opus-bytes");
        let (_, tail) = FrameHeader::parse(&buf).expect("parse");
        assert_eq!(tail, b"opus-bytes");
    }

    /// Bad VU metadata is not audible loss: the level clamps to the silence
    /// floor, every other field and the payload survive.
    #[test]
    fn out_of_range_level_dbov_is_clamped_not_rejected() {
        let mut bytes = FrameHeader {
            seq: 7,
            ts_48k: 7 * 960,
            level_dbov: 0,
            flags: 0,
        }
        .encode()
        .to_vec();
        bytes[6] = 0x7F; // +127, outside [-127, 0]
        bytes.extend_from_slice(b"opus");
        let (parsed, tail) = FrameHeader::parse(&bytes).expect("parse must succeed");
        assert_eq!(parsed.level_dbov, -127);
        assert_eq!(parsed.seq, 7);
        assert_eq!(tail, b"opus");
    }

    /// Reserved bits are preserved for inspection and never interpreted.
    #[test]
    fn reserved_flag_bits_are_preserved_not_interpreted() {
        let mut bytes = [0u8; V2_HEADER_LEN];
        bytes[7] = 0b1010_1010;
        let (parsed, _) = FrameHeader::parse(&bytes).expect("parse");
        assert_eq!(parsed.flags, 0b1010_1010);
        assert!(!parsed.is_dtx());
        assert_eq!(parsed.flags & RESERVED_FLAG_MASK, 0b1010_1010);
    }
}

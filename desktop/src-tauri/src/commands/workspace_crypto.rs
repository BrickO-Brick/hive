//! NIP-SW AES-256-GCM metadata primitives.
//!
//! Keys and plaintext cross this boundary only for the duration of the
//! operation. The wire envelope is the frozen `aes256gcm:<nonce>:<ciphertext>`
//! encoding from NIP-SW.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use getrandom::getrandom;

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const PREFIX: &str = "aes256gcm";

fn decode_key(key_hex: &str) -> Result<[u8; KEY_BYTES], String> {
    let bytes =
        hex::decode(key_hex).map_err(|_| "workspace key must be lowercase hex".to_string())?;
    if bytes.len() != KEY_BYTES
        || key_hex.len() != KEY_BYTES * 2
        || key_hex
            .chars()
            .any(|c| !c.is_ascii_hexdigit() || c.is_ascii_uppercase())
    {
        return Err("workspace key must be exactly 32 bytes of lowercase hex".into());
    }
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn cipher(key_hex: &str) -> Result<Aes256Gcm, String> {
    let key = decode_key(key_hex)?;
    Aes256Gcm::new_from_slice(&key).map_err(|_| "invalid workspace key".into())
}

fn encrypt_with_nonce(
    key_hex: &str,
    plaintext: &[u8],
    aad: &[u8],
    nonce: &[u8; NONCE_BYTES],
) -> Result<String, String> {
    let cipher = cipher(key_hex)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            aes_gcm::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "workspace metadata encryption failed".to_string())?;
    Ok(format!(
        "{PREFIX}:{}:{}",
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(encrypted),
    ))
}

fn parse_envelope(envelope: &str) -> Result<([u8; NONCE_BYTES], Vec<u8>), String> {
    let parts = envelope.split(':').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != PREFIX {
        return Err("invalid workspace metadata envelope".into());
    }
    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "invalid workspace metadata nonce".to_string())?;
    if nonce_bytes.len() != NONCE_BYTES {
        return Err("workspace metadata nonce must be exactly 12 bytes".into());
    }
    let ciphertext = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "invalid workspace metadata ciphertext".to_string())?;
    if ciphertext.len() < TAG_BYTES {
        return Err("workspace metadata ciphertext is too short".into());
    }
    let mut nonce = [0u8; NONCE_BYTES];
    nonce.copy_from_slice(&nonce_bytes);
    Ok((nonce, ciphertext))
}

fn decrypt_inner(key_hex: &str, envelope: &str, aad: &[u8]) -> Result<String, String> {
    let (nonce, ciphertext) = parse_envelope(envelope)?;
    let cipher = cipher(key_hex)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| "workspace metadata authentication failed".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "workspace metadata is not valid UTF-8".into())
}

pub(crate) fn generate_key_hex() -> Result<String, String> {
    let mut key = [0u8; KEY_BYTES];
    getrandom(&mut key).map_err(|_| "workspace key generation failed".to_string())?;
    Ok(hex::encode(key))
}

#[tauri::command]
pub fn generate_workspace_key() -> Result<String, String> {
    generate_key_hex()
}

#[tauri::command]
pub fn encrypt_workspace_metadata(
    key_hex: String,
    plaintext: String,
    aad: String,
) -> Result<String, String> {
    let mut nonce = [0u8; NONCE_BYTES];
    getrandom(&mut nonce).map_err(|_| "workspace metadata nonce generation failed".to_string())?;
    encrypt_with_nonce(&key_hex, plaintext.as_bytes(), aad.as_bytes(), &nonce)
}

#[tauri::command]
pub fn decrypt_workspace_metadata(
    key_hex: String,
    envelope: String,
    aad: String,
) -> Result<String, String> {
    decrypt_inner(&key_hex, &envelope, aad.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const AAD: &[u8] = b"{\"version\":1}";

    #[test]
    fn round_trip_matches_frozen_encoding() {
        let nonce = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        let aad = b"{\"community\":\"relay.example\",\"key_epoch\":1,\"owner_pubkey\":\"1111111111111111111111111111111111111111111111111111111111111111\",\"purpose\":\"label\",\"section_id\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"version\":1}";
        let envelope = encrypt_with_nonce(KEY, b"Alpha", aad, &nonce).unwrap();
        assert_eq!(
            envelope,
            "aes256gcm:AAECAwQFBgcICQoL:Bm6mc6SHvhxcEB6Q1Lc56VuJZjD7"
        );
        assert_eq!(decrypt_inner(KEY, &envelope, aad).unwrap(), "Alpha");
    }

    #[test]
    fn wrong_aad_and_tampering_fail_authentication() {
        let nonce = [0u8; NONCE_BYTES];
        let envelope = encrypt_with_nonce(KEY, b"Alpha", AAD, &nonce).unwrap();
        assert_eq!(
            decrypt_inner(KEY, &envelope, b"wrong"),
            Err("workspace metadata authentication failed".into())
        );
        let mut tampered = envelope.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        assert_eq!(
            decrypt_inner(KEY, std::str::from_utf8(&tampered).unwrap(), AAD),
            Err("workspace metadata authentication failed".into())
        );
    }

    #[test]
    fn malformed_key_nonce_and_envelope_fail_closed() {
        assert!(decode_key("00").is_err());
        assert!(parse_envelope("aes256gcm:AAECAwQFBgcICQoL").is_err());
        assert!(parse_envelope("aes256gcm:AAECAwQFBgcICQoL:not-base64!").is_err());
        assert!(parse_envelope("aes256gcm:AAECAwQFBgcICQo:AA==").is_err());
    }
}

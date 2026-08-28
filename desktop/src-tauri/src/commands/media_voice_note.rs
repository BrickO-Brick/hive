use tokio_util::sync::CancellationToken;

use super::media_transcode::transcode_voice_note_to_mp4_with_cancellation;

pub(super) fn is_voice_note_filename(filename: Option<&str>) -> bool {
    filename.is_some_and(|name| {
        let lower = name.to_ascii_lowercase();
        lower.starts_with("voice-note-") && lower.ends_with(".wav")
    })
}

pub(super) fn voice_note_mp4_filename(filename: &str) -> String {
    filename
        .strip_suffix(".wav")
        .or_else(|| filename.strip_suffix(".WAV"))
        .map_or_else(|| format!("{filename}.mp4"), |stem| format!("{stem}.mp4"))
}

pub(super) async fn prepare_voice_note_for_upload(
    data: Vec<u8>,
    cancellation: Option<&CancellationToken>,
) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    let cancellation = cancellation.cloned();
    tokio::task::spawn_blocking(move || {
        let detected = infer::get(&data)
            .ok_or_else(|| "Voice note has an unrecognized audio format.".to_string())?;
        if !detected.mime_type().starts_with("audio/") {
            return Err("Voice note upload did not contain audio.".to_string());
        }

        let tmp_input =
            std::env::temp_dir().join(format!("buzz-voice-input-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            std::fs::write(&tmp_input, &data)
                .map_err(|error| format!("failed to prepare voice note: {error}"))?;
            let output =
                transcode_voice_note_to_mp4_with_cancellation(&tmp_input, cancellation.as_ref())?;
            let bytes = std::fs::read(&output)
                .map_err(|error| format!("failed to read prepared voice note: {error}"));
            let _ = std::fs::remove_file(&output);
            bytes.map(|bytes| (bytes, None))
        })();
        let _ = std::fs::remove_file(&tmp_input);
        result
    })
    .await
    .map_err(|error| format!("voice note task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{is_voice_note_filename, voice_note_mp4_filename};

    #[test]
    fn voice_note_filenames_are_scoped_and_rewritten_for_video_upload() {
        assert!(is_voice_note_filename(Some("voice-note-123.wav")));
        assert!(!is_voice_note_filename(Some("meeting.wav")));
        assert!(!is_voice_note_filename(Some("voice-note-123.mp4")));
        assert_eq!(
            voice_note_mp4_filename("voice-note-123.wav"),
            "voice-note-123.mp4"
        );
    }
}

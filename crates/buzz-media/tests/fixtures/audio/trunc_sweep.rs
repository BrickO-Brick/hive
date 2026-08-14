fn cfg() -> buzz_media::config::MediaConfig {
    buzz_media::config::MediaConfig {
        s3_endpoint: String::new(), s3_access_key: String::new(),
        s3_secret_key: String::new(), s3_bucket: String::new(),
        s3_region: "us-east-1".into(),
        s3_addressing_style: buzz_media::config::S3AddressingStyle::Path,
        max_image_bytes: 50*1024*1024, max_gif_bytes: 10*1024*1024,
        max_video_bytes: 524_288_000, max_file_bytes: 104_857_600,
        max_audio_bytes: 26_214_400,
        public_base_url: "http://localhost:3000/media".into(),
        upload_records_enabled: false, upload_ip_header: None, upload_port_header: None,
    }
}

fn sweep(name: &str, full: &[u8], repair_riff: bool) -> Option<usize> {
    let mut first = None;
    let lens: Vec<usize> = (0..full.len().min(600)).chain((600..full.len()).step_by(97)).collect();
    for n in lens {
        let mut slice = full[..n].to_vec();
        // Keep the RIFF declared size consistent with the truncated length, or
        // the `declared + 8 == len` gate rejects everything before the fmt walk
        // and the sweep never reaches the code under test.
        if repair_riff && slice.len() >= 8 {
            let d = (slice.len() - 8) as u32;
            slice[4..8].copy_from_slice(&d.to_le_bytes());
        }
        let r = std::panic::catch_unwind(|| {
            let _ = buzz_media::validation::validate_file_content(&slice, &cfg());
        });
        if r.is_err() && first.is_none() { first = Some(n); }
    }
    match first {
        None => println!("{name:24} OK  (no panic at any prefix)"),
        Some(n) => println!("{name:24} *** first panic at prefix {n} ***"),
    }
    first
}

#[test]
fn dawn_truncation_sweep_all_containers() {
    let dir = std::path::PathBuf::from(std::env::var("DAWN_SAN").unwrap());
    let mut bad = Vec::new();
    for name in ["tagged.mp3","mpeg2_22k.mp3","mpeg25_11k.mp3","tagged.ogg","bigart.ogg","long.ogg"] {
        let full = std::fs::read(dir.join(name)).unwrap();
        if sweep(name, &full, false).is_some() { bad.push(name); }
    }
    // WAV twice: naive (declared size left stale) and repaired (reaches fmt walk).
    let wav = std::fs::read(dir.join("tagged.wav")).unwrap();
    if sweep("tagged.wav (naive)", &wav, false).is_some() { bad.push("wav-naive"); }
    if sweep("tagged.wav (riff-repaired)", &wav, true).is_some() { bad.push("wav-repaired"); }
    assert!(bad.is_empty(), "validator panicked: {bad:?}");
}

//! Printable recovery-code sheet for a Buzz 2SKD recovery kit.
//!
//! The PDF deliberately contains only the recovery code and public identity.
//! It never contains the password, private key, or encrypted backup artifact.

use printpdf::{
    BuiltinFont, Color, Mm, Op, PaintMode, PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions,
    Point, Pt, RawImage, Rect, Rgb, TextItem, WindingOrder, XObjectTransform,
};
use qrcode::{Color as QrColor, EcLevel, QrCode};

pub const RECOVERY_SHEET_FILE_NAME: &str = "buzz-recovery-sheet.pdf";

const PAGE_WIDTH_MM: f32 = 215.9;
const PAGE_HEIGHT_MM: f32 = 279.4;
const BUZZ_WORDMARK: &[u8] = include_bytes!("../../public/landing/buzz-wordmark.png");

fn charcoal() -> Color {
    Color::Rgb(Rgb::new(35.0 / 255.0, 30.0 / 255.0, 30.0 / 255.0, None))
}

fn buzz_yellow() -> Color {
    Color::Rgb(Rgb::new(215.0 / 255.0, 215.0 / 255.0, 46.0 / 255.0, None))
}

fn cream() -> Color {
    Color::Rgb(Rgb::new(247.0 / 255.0, 247.0 / 255.0, 235.0 / 255.0, None))
}

fn muted() -> Color {
    Color::Rgb(Rgb::new(100.0 / 255.0, 94.0 / 255.0, 83.0 / 255.0, None))
}

fn white() -> Color {
    Color::Rgb(Rgb::new(1.0, 1.0, 1.0, None))
}

fn rect(x: f32, y: f32, width: f32, height: f32, mode: PaintMode) -> Rect {
    Rect {
        x: Mm(x).into(),
        y: Mm(y).into(),
        width: Mm(width).into(),
        height: Mm(height).into(),
        mode: Some(mode),
        winding_order: Some(WindingOrder::NonZero),
    }
}

fn fill_rect(ops: &mut Vec<Op>, x: f32, y: f32, width: f32, height: f32, color: Color) {
    ops.push(Op::SetFillColor { col: color });
    ops.push(Op::DrawRectangle {
        rectangle: rect(x, y, width, height, PaintMode::Fill),
    });
}

fn fill_stroke_rect(
    ops: &mut Vec<Op>,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    fill: Color,
    stroke: Color,
) {
    ops.push(Op::SetFillColor { col: fill });
    ops.push(Op::SetOutlineColor { col: stroke });
    ops.push(Op::SetOutlineThickness { pt: Pt(0.8) });
    ops.push(Op::DrawRectangle {
        rectangle: rect(x, y, width, height, PaintMode::FillStroke),
    });
}

fn text(
    ops: &mut Vec<Op>,
    x: f32,
    y: f32,
    size: f32,
    font: BuiltinFont,
    color: Color,
    value: impl Into<String>,
) {
    ops.extend([
        Op::StartTextSection,
        Op::SetFillColor { col: color },
        Op::SetTextCursor {
            pos: Point::new(Mm(x), Mm(y)),
        },
        Op::SetFont {
            font: PdfFontHandle::Builtin(font),
            size: Pt(size),
        },
        Op::ShowText {
            items: vec![TextItem::Text(value.into())],
        },
        Op::EndTextSection,
    ]);
}

fn draw_dot_grid(ops: &mut Vec<Op>) {
    let dot = Color::Rgb(Rgb::new(211.0 / 255.0, 209.0 / 255.0, 198.0 / 255.0, None));
    let mut y = 215.0;
    let mut row = 0usize;
    while y < 274.0 {
        let offset = if row.is_multiple_of(2) { 0.0 } else { 3.5 };
        let mut x = 136.0 + offset;
        while x < 211.0 {
            fill_rect(ops, x, y, 0.4, 0.4, dot.clone());
            x += 7.0;
        }
        y += 7.0;
        row += 1;
    }
}

fn draw_qr(ops: &mut Vec<Op>, recovery_secret: &str) -> Result<(), String> {
    let code = QrCode::with_error_correction_level(recovery_secret.as_bytes(), EcLevel::Q)
        .map_err(|error| format!("encode recovery-code QR: {error}"))?;
    let quiet_modules = 4usize;
    let total_modules = code.width() + quiet_modules * 2;
    let qr_size_mm = 56.0f32;
    let module_mm = qr_size_mm / total_modules as f32;
    let qr_x = 136.0f32;
    let qr_y = 105.0f32;

    fill_rect(ops, qr_x, qr_y, qr_size_mm, qr_size_mm, white());
    for y in 0..code.width() {
        for x in 0..code.width() {
            if code[(x, y)] == QrColor::Dark {
                let module_x = qr_x + (x + quiet_modules) as f32 * module_mm;
                let module_y = qr_y + (code.width() - 1 - y + quiet_modules) as f32 * module_mm;
                fill_rect(ops, module_x, module_y, module_mm, module_mm, charcoal());
            }
        }
    }
    Ok(())
}

fn split_npub(npub: &str) -> (&str, &str) {
    let split_at = npub.len().min(32);
    npub.split_at(split_at)
}

/// Render a one-page, print-ready recovery sheet.
pub(crate) fn render_recovery_sheet(
    recovery_secret: &str,
    npub: &str,
    created_date: &str,
) -> Result<Vec<u8>, String> {
    crate::two_skd::validate_recovery_secret(recovery_secret)?;
    if !npub.starts_with("npub1") || npub.len() < 20 {
        return Err("invalid recovery-sheet identity".to_string());
    }

    let mut document = PdfDocument::new("Buzz recovery sheet");
    let mut ops = Vec::new();

    fill_rect(&mut ops, 0.0, 0.0, PAGE_WIDTH_MM, PAGE_HEIGHT_MM, white());
    fill_rect(&mut ops, 0.0, 276.4, PAGE_WIDTH_MM, 3.0, buzz_yellow());
    draw_dot_grid(&mut ops);

    let mut warnings = Vec::new();
    let wordmark = RawImage::decode_from_bytes(BUZZ_WORDMARK, &mut warnings)
        .map_err(|error| format!("decode Buzz wordmark: {error}"))?;
    let wordmark_id = document.add_image(&wordmark);
    ops.push(Op::UseXobject {
        id: wordmark_id,
        transform: XObjectTransform {
            translate_x: Some(Mm(18.0).into()),
            translate_y: Some(Mm(242.0).into()),
            scale_x: Some(0.82),
            scale_y: Some(0.82),
            dpi: Some(300.0),
            ..Default::default()
        },
    });

    text(
        &mut ops,
        18.0,
        231.0,
        8.0,
        BuiltinFont::HelveticaBold,
        charcoal(),
        "RECOVERY SHEET / KEEP OFFLINE",
    );
    text(
        &mut ops,
        18.0,
        211.0,
        27.0,
        BuiltinFont::HelveticaBold,
        charcoal(),
        "Keep this separate.",
    );
    text(
        &mut ops,
        18.0,
        200.5,
        11.0,
        BuiltinFont::Helvetica,
        charcoal(),
        "This paper is one of three things required to recover your identity.",
    );
    fill_rect(&mut ops, 18.0, 188.0, 24.0, 2.0, buzz_yellow());

    fill_stroke_rect(&mut ops, 18.0, 78.0, 179.9, 104.0, white(), charcoal());
    text(
        &mut ops,
        28.0,
        165.0,
        8.0,
        BuiltinFont::HelveticaBold,
        muted(),
        "YOUR RECOVERY CODE",
    );
    text(
        &mut ops,
        28.0,
        151.0,
        19.0,
        BuiltinFont::HelveticaBold,
        charcoal(),
        "One code.",
    );
    text(
        &mut ops,
        28.0,
        142.5,
        19.0,
        BuiltinFont::HelveticaBold,
        charcoal(),
        "Store it offline.",
    );
    fill_stroke_rect(&mut ops, 28.0, 122.0, 96.0, 11.0, cream(), muted());
    fill_rect(&mut ops, 28.0, 122.0, 2.0, 11.0, buzz_yellow());
    text(
        &mut ops,
        32.0,
        126.0,
        8.0,
        BuiltinFont::CourierBold,
        charcoal(),
        recovery_secret,
    );

    text(
        &mut ops,
        28.0,
        111.0,
        7.0,
        BuiltinFont::HelveticaBold,
        muted(),
        "BUZZ IDENTITY",
    );
    let (npub_first, npub_second) = split_npub(npub);
    text(
        &mut ops,
        28.0,
        104.5,
        7.5,
        BuiltinFont::Courier,
        charcoal(),
        npub_first,
    );
    text(
        &mut ops,
        28.0,
        99.5,
        7.5,
        BuiltinFont::Courier,
        charcoal(),
        npub_second,
    );
    text(
        &mut ops,
        28.0,
        89.0,
        7.0,
        BuiltinFont::HelveticaBold,
        muted(),
        format!("CREATED {created_date}"),
    );

    draw_qr(&mut ops, recovery_secret)?;
    text(
        &mut ops,
        143.0,
        96.0,
        7.0,
        BuiltinFont::Helvetica,
        muted(),
        "QR CONTAINS THE RECOVERY CODE",
    );

    text(
        &mut ops,
        18.0,
        67.5,
        8.0,
        BuiltinFont::HelveticaBold,
        muted(),
        "RECOVERY NEEDS ALL THREE",
    );
    let requirements = [
        ("1", "Encrypted backup", "identity.buzzbackup"),
        ("2", "Your password", "Known only to you"),
        ("3", "This sheet", "Stored separately"),
    ];
    for (index, (number, title, detail)) in requirements.iter().enumerate() {
        let x = 18.0 + index as f32 * 61.0;
        fill_stroke_rect(&mut ops, x, 39.0, 57.9, 23.0, white(), charcoal());
        fill_rect(&mut ops, x, 54.0, 8.0, 8.0, buzz_yellow());
        text(
            &mut ops,
            x + 2.55,
            56.2,
            8.0,
            BuiltinFont::HelveticaBold,
            charcoal(),
            *number,
        );
        text(
            &mut ops,
            x + 4.0,
            48.0,
            9.0,
            BuiltinFont::HelveticaBold,
            charcoal(),
            *title,
        );
        text(
            &mut ops,
            x + 4.0,
            42.5,
            7.0,
            BuiltinFont::Helvetica,
            muted(),
            *detail,
        );
    }

    fill_stroke_rect(&mut ops, 18.0, 14.0, 179.9, 17.0, white(), charcoal());
    fill_rect(&mut ops, 18.0, 14.0, 3.0, 17.0, buzz_yellow());
    text(
        &mut ops,
        24.0,
        24.0,
        9.0,
        BuiltinFont::HelveticaBold,
        charcoal(),
        "DO NOT STORE THIS SHEET WITH YOUR ENCRYPTED BACKUP.",
    );
    text(
        &mut ops,
        24.0,
        18.5,
        8.0,
        BuiltinFont::Helvetica,
        muted(),
        "Buzz cannot recreate this code or reset your recovery password.",
    );
    text(
        &mut ops,
        18.0,
        6.0,
        7.0,
        BuiltinFont::HelveticaBold,
        muted(),
        "buzz.xyz / recovery sheet v1",
    );

    let page = PdfPage::new(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), ops);
    let bytes = document
        .with_pages(vec![page])
        .save(&PdfSaveOptions::default(), &mut warnings);
    if !bytes.starts_with(b"%PDF-") {
        return Err("render recovery sheet: invalid PDF output".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use printpdf::{PdfDocument, PdfParseOptions};

    const RECOVERY_CODE: &str = "buzz-recovery-v1-00112233445566778899aabbccddeeff";
    const NPUB: &str = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5hq3g5";

    #[test]
    fn renders_a_single_page_with_recovery_material_and_no_backup() {
        let bytes = render_recovery_sheet(RECOVERY_CODE, NPUB, "August 21, 2026").unwrap();
        let mut warnings = Vec::new();
        let parsed = PdfDocument::parse(
            &bytes,
            &PdfParseOptions {
                fail_on_error: true,
            },
            &mut warnings,
        )
        .unwrap();
        let text = parsed
            .extract_text()
            .into_iter()
            .flatten()
            .collect::<String>();

        assert_eq!(parsed.pages.len(), 1);
        assert!(text.contains(RECOVERY_CODE));
        assert!(text.contains("Keep this separate."));
        assert!(text.contains(NPUB));
        assert!(!text.contains("buzz2skd1:"));
        assert!(!text.contains("password="));

        if let Ok(path) = std::env::var("BUZZ_RECOVERY_SHEET_PREVIEW") {
            std::fs::write(path, bytes).unwrap();
        }
    }

    #[test]
    fn rejects_malformed_recovery_material() {
        assert!(render_recovery_sheet("not-a-code", NPUB, "August 21, 2026").is_err());
        assert!(render_recovery_sheet(RECOVERY_CODE, "not-an-npub", "August 21, 2026").is_err());
    }
}

from __future__ import annotations

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
CAPTURE_DIR = ROOT / "docs/assets/hive-team-guide"
OUTPUT = ROOT / "output/pdf/hive-team-guide.pdf"
ICON = ROOT / "web/src/assets/hive-icon.png"
FONT_DIR = ROOT / "web/node_modules/@fontsource-variable/inter/files"

NAVY = HexColor("#10233F")
CORAL = HexColor("#FF6F52")
BLUE = HexColor("#2F6FED")
TEXT = HexColor("#42526B")
MUTED = HexColor("#607086")
BORDER = HexColor("#D8DEE8")
PALE = HexColor("#F7FAFC")
PALE_BLUE = HexColor("#EEF5FF")
WHITE = HexColor("#FFFFFF")


def register_fonts() -> None:
    regular = next(FONT_DIR.glob("inter-latin-wght-normal-*.woff2"), None)
    if regular:
        try:
            pdfmetrics.registerFont(TTFont("Inter", str(regular)))
            return
        except Exception:
            pass


register_fonts()
FONT = "Inter" if "Inter" in pdfmetrics.getRegisteredFontNames() else "Helvetica"
FONT_BOLD = "Helvetica-Bold"

styles = getSampleStyleSheet()
TITLE = ParagraphStyle(
    "Title",
    parent=styles["Title"],
    fontName=FONT_BOLD,
    fontSize=25,
    leading=30,
    textColor=NAVY,
    spaceAfter=6,
)
SUBTITLE = ParagraphStyle(
    "Subtitle",
    parent=styles["BodyText"],
    fontName=FONT,
    fontSize=11,
    leading=16,
    textColor=MUTED,
)
STEP_TITLE = ParagraphStyle(
    "StepTitle",
    parent=styles["Heading1"],
    fontName=FONT_BOLD,
    fontSize=18,
    leading=22,
    textColor=NAVY,
    spaceAfter=4,
)
BODY = ParagraphStyle(
    "Body",
    parent=styles["BodyText"],
    fontName=FONT,
    fontSize=9.5,
    leading=14,
    textColor=TEXT,
)
SMALL = ParagraphStyle(
    "Small",
    parent=BODY,
    fontSize=8,
    leading=11,
    textColor=MUTED,
)
CALLOUT = ParagraphStyle(
    "Callout",
    parent=BODY,
    fontName=FONT_BOLD,
    fontSize=9,
    leading=13,
    textColor=NAVY,
)


def footer(canvas, doc) -> None:
    canvas.saveState()
    width, _ = landscape(A4)
    canvas.setStrokeColor(BORDER)
    canvas.line(18 * mm, 12 * mm, width - 18 * mm, 12 * mm)
    canvas.setFont(FONT, 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 7.5 * mm, "Hive Web - Team Guidance")
    canvas.drawRightString(width - 18 * mm, 7.5 * mm, f"Page {doc.page}")
    canvas.restoreState()


def screenshot(path: Path, max_width: float = 755, max_height: float = 350) -> Image:
    image = Image(str(path))
    scale = min(max_width / image.imageWidth, max_height / image.imageHeight)
    image.drawWidth = image.imageWidth * scale
    image.drawHeight = image.imageHeight * scale
    image.hAlign = "CENTER"
    return image


def step_header(number: int, title: str, body: str):
    badge = Table(
        [[Paragraph(str(number), ParagraphStyle("Badge", parent=BODY, fontName=FONT_BOLD, fontSize=12, textColor=WHITE, alignment=TA_CENTER))]],
        colWidths=[9 * mm],
        rowHeights=[9 * mm],
    )
    badge.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), CORAL),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ("BOX", (0, 0), (-1, -1), 0.5, CORAL),
            ]
        )
    )
    copy = [Paragraph(title, STEP_TITLE), Paragraph(body, BODY)]
    table = Table([[badge, "", copy]], colWidths=[9 * mm, 4 * mm, 242 * mm])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return table


def callout(text: str, color=PALE_BLUE) -> Table:
    box = Table([[Paragraph(text, CALLOUT)]], colWidths=[255 * mm])
    box.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), color),
                ("BOX", (0, 0), (-1, -1), 0.6, BORDER),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return box


def build() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=landscape(A4),
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=14 * mm,
        bottomMargin=17 * mm,
        title="Hive Web - Panduan Tim",
        author="BrickO",
        subject="Panduan langkah demi langkah penggunaan Hive Web",
    )
    story = []

    cover_icon = Image(str(ICON), width=33 * mm, height=33 * mm)
    cover_icon.hAlign = "CENTER"
    story.extend(
        [
            Spacer(1, 18 * mm),
            cover_icon,
            Spacer(1, 5 * mm),
            Paragraph("Hive Web", ParagraphStyle("Cover", parent=TITLE, fontSize=34, leading=40, alignment=TA_CENTER)),
            Paragraph("Panduan praktis untuk chat tim, diskusi repositori, mention, thread, dan Simple IDE", ParagraphStyle("CoverSub", parent=SUBTITLE, fontSize=14, leading=20, alignment=TA_CENTER)),
            Spacer(1, 12 * mm),
        ]
    )
    mental = Table(
        [
            [Paragraph("CHATS", CALLOUT), Paragraph("REPOSITORIES", CALLOUT), Paragraph("THREADS", CALLOUT)],
            [
                Paragraph("Percakapan umum yang tidak harus terikat repositori.", BODY),
                Paragraph("Kelompok kerja kode. Setiap repositori berisi diskusi terpisah.", BODY),
                Paragraph("Balasan fokus di dalam sebuah pesan tanpa memenuhi timeline utama.", BODY),
            ],
        ],
        colWidths=[82 * mm, 82 * mm, 82 * mm],
    )
    mental.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), PALE_BLUE),
                ("BOX", (0, 0), (-1, -1), 0.7, BORDER),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 12),
                ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                ("TOPPADDING", (0, 0), (-1, -1), 10),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ]
        )
    )
    story.extend(
        [
            mental,
            Spacer(1, 9 * mm),
            callout("Prinsip cepat: mulai dari Chats untuk koordinasi umum. Pilih Repositories jika pekerjaan memerlukan konteks kode, branch, dan workspace terisolasi."),
            Spacer(1, 5 * mm),
            Paragraph("Versi panduan: 5 September 2026 - fokus Hive Web. Simple IDE membuat commit lokal saja; push, merge, dan deploy tetap berada di alur engineering terpisah.", SMALL),
        ]
    )

    pages = [
        (
            1,
            "Kenali navigasi utama",
            "Rail paling kiri berpindah antara Chats dan Repositories. Panel kedua menampilkan chat umum serta repositori yang dapat dibuka-tutup. Gunakan Search or jump to untuk menemukan chat, repositori, atau judul diskusi.",
            CAPTURE_DIR / "01-navigation.png",
            "Tip: klik panah di samping nama repositori untuk melihat atau menyembunyikan daftar diskusinya.",
        ),
        (
            2,
            "Mention rekan atau BrickO",
            "Klik composer lalu ketik @. Hive langsung menampilkan anggota channel dan BrickO. Ketik beberapa huruf untuk menyaring, gunakan tombol panah untuk memilih, lalu Enter atau Tab untuk memasukkan mention.",
            CAPTURE_DIR / "02-mention-picker.png",
            "BrickO selalu diberi label Agent. Tekan Esc bila ingin menutup daftar mention tanpa memilih.",
        ),
        (
            3,
            "Buat chat umum tanpa repositori",
            "Klik New chat pada bagian Chats. Isi nama percakapan, misalnya Engineering, lalu klik Create chat. Chat ini langsung muncul di navigasi dan tidak membuat branch atau worktree.",
            CAPTURE_DIR / "03-new-chat.png",
            "Gunakan chat umum untuk koordinasi lintas repositori, pengumuman, atau diskusi tim yang tidak memerlukan perubahan kode.",
        ),
        (
            4,
            "Mulai percakapan grup",
            "Setelah chat dibuat, tulis pesan pertama. Mention anggota yang perlu merespons. Setiap pesan tetap dapat memiliki thread agar pembahasan rinci tidak memenuhi timeline utama.",
            CAPTURE_DIR / "04-group-chat.png",
            "Chat umum dan diskusi repositori sengaja dipisahkan supaya konteks kerja selalu jelas.",
        ),
        (
            5,
            "Temukan repositori",
            "Klik ikon Repositories pada rail atau tombol plus di judul Repositories. Gunakan pencarian dan kategori untuk menemukan repositori, lalu klik Start discussion pada kartu yang sesuai.",
            CAPTURE_DIR / "05-repositories.png",
            "Pastikan repositori yang dipilih benar sebelum membuat diskusi karena Hive menyiapkan workspace terisolasi untuk topik tersebut.",
        ),
        (
            6,
            "Buat diskusi repositori",
            "Masukkan judul yang menjelaskan hasil yang ingin dicapai. Hive akan menyiapkan branch dan worktree khusus tanpa melakukan push ke GitHub pada saat pembuatan.",
            CAPTURE_DIR / "06-new-repo-discussion.png",
            "Satu diskusi = satu topik kerja. Buat diskusi baru untuk tujuan yang berbeda agar perubahan dan bukti pengujian tidak tercampur.",
        ),
        (
            7,
            "Bekerja di diskusi repositori",
            "Header dan kartu workspace menunjukkan repositori, branch, base, serta HEAD. Kirim instruksi ke BrickO dari composer; semua pesan dalam diskusi membawa konteks workspace yang sama.",
            CAPTURE_DIR / "07-repo-discussion.png",
            "Jangan menyalin secret, token, OTP, atau data pelanggan ke chat. Gunakan referensi aman dan bukti non-secret.",
        ),
        (
            8,
            "Balas dengan thread",
            "Klik Reply in this thread di bawah pesan. Buka tombol Threads di header untuk melihat balasan aktif. Pilih Reply in thread pada panel kanan untuk meneruskan konteks yang sama.",
            CAPTURE_DIR / "08-reply-thread.png",
            "Gunakan thread untuk investigasi rinci, log sanitasi, dan follow-up. Kembali ke timeline utama untuk keputusan yang perlu terlihat oleh semua anggota.",
        ),
    ]

    from reportlab.platypus import PageBreak

    for number, title, body, image_path, tip in pages:
        story.extend(
            [
                PageBreak(),
                step_header(number, title, body),
                Spacer(1, 3 * mm),
                screenshot(image_path),
                Spacer(1, 3 * mm),
                callout(tip, PALE),
            ]
        )

    story.extend(
        [
            PageBreak(),
            Paragraph("Coding dari diskusi", TITLE),
            Paragraph(
                "Alur Hive Web membawa pekerjaan kode dari percakapan sampai commit lokal yang siap direview, tanpa menyembunyikan batas antara diskusi, perubahan file, commit, dan push.",
                SUBTITLE,
            ),
            Spacer(1, 8 * mm),
        ]
    )
    capability = Table(
        [
            [Paragraph("DISKUSI + BRICKO", CALLOUT), Paragraph("SIMPLE IDE WEB", CALLOUT)],
            [
                Paragraph(
                    "Diskusi terikat repositori dan workspace terisolasi. Anggota dapat memberi konteks dan meminta bantuan BrickO di percakapan sebelum engineer membuka file yang sama untuk perubahan ringan.",
                    BODY,
                ),
                Paragraph(
                    "Simple IDE langsung di Hive Web untuk file teks terlacak: simpan draft, review unified diff, lalu buat commit lokal secara eksplisit. Tidak ada push, merge, atau deploy otomatis.",
                    BODY,
                ),
            ],
        ],
        colWidths=[124 * mm, 124 * mm],
    )
    capability.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, 0), PALE_BLUE),
                ("BACKGROUND", (1, 0), (1, 0), HexColor("#FFF0EC")),
                ("BOX", (0, 0), (-1, -1), 0.7, BORDER),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 12),
                ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                ("TOPPADDING", (0, 0), (-1, -1), 11),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
            ]
        )
    )
    flow = Table(
        [
            [
                Paragraph("1. DISCUSS", CALLOUT),
                Paragraph("2. EDIT DRAFT", CALLOUT),
                Paragraph("3. REVIEW", CALLOUT),
                Paragraph("4. LOCAL COMMIT", CALLOUT),
            ],
            [
                Paragraph("Jelaskan hasil dan batasan di diskusi repositori.", BODY),
                Paragraph("Engineer mengubah file kecil atau meminta BrickO membantu.", BODY),
                Paragraph("Periksa diff dan pastikan tidak ada secret sebelum membuat commit.", BODY),
                Paragraph("Buat commit lokal. Push tetap aksi terpisah melalui policy repositori.", BODY),
            ],
        ],
        colWidths=[62 * mm] * 4,
    )
    flow.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), PALE),
                ("BOX", (0, 0), (-1, -1), 0.7, BORDER),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 9),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
            ]
        )
    )
    story.extend(
        [
            capability,
            Spacer(1, 8 * mm),
            flow,
            Spacer(1, 8 * mm),
            callout(
                "Batas aman: Simple IDE ditujukan untuk edit ringan. Refactor besar, debugging kompleks, dan pekerjaan multi-service tetap lebih cocok dibuka di IDE penuh."
            ),
        ]
    )

    proposal_pages = [
        (
            9,
            "Minta update kode dari diskusi",
            "Engineer menjelaskan hasil yang diinginkan dan mention BrickO untuk menyamakan konteks. Saat siap mengubah kode, klik Open Simple IDE pada kartu workspace diskusi. Hive tidak melakukan push otomatis.",
            CAPTURE_DIR / "09-code-update-request.png",
            "Open Simple IDE tersedia dari diskusi repositori. Untuk perubahan besar atau debugging kompleks, lanjutkan di IDE penuh.",
        ),
        (
            10,
            "Edit langsung dengan Simple IDE",
            "Pilih file teks terlacak, lakukan edit ringan, lalu klik Save draft. Daftar Changes menunjukkan file yang sudah berubah di worktree terisolasi; belum ada commit atau push.",
            CAPTURE_DIR / "10-simple-ide.png",
            "Hive memperingatkan sebelum edit yang belum disimpan dibuang. Jika file berubah dari sesi lain, muat ulang sebelum menyimpan kembali.",
        ),
        (
            11,
            "Review sebelum membuat commit",
            "Klik Review changes untuk melihat unified diff serta jumlah file, baris tambah, dan baris hapus. Isi commit message, lalu klik Create commit untuk membuat commit lokal pada branch diskusi.",
            CAPTURE_DIR / "11-review-changes.png",
            "Tidak ada push, merge, atau deploy otomatis dari Simple IDE. Validasi test dan secret scan tetap dilakukan melalui alur engineering yang berlaku.",
        ),
    ]
    for number, title, body, image_path, tip in proposal_pages:
        story.extend(
            [
                PageBreak(),
                step_header(number, title, body),
                Spacer(1, 3 * mm),
                screenshot(image_path),
                Spacer(1, 3 * mm),
                callout(tip, PALE),
            ]
        )

    story.extend(
        [
            PageBreak(),
            Paragraph("Checklist kebiasaan tim", TITLE),
            Paragraph("Gunakan daftar ini sebelum meminta atau menutup pekerjaan di Hive.", SUBTITLE),
            Spacer(1, 7 * mm),
        ]
    )
    checklist = [
        ("1", "Pilih ruang yang tepat", "Chat umum untuk koordinasi; diskusi repositori untuk pekerjaan kode."),
        ("2", "Beri judul yang spesifik", "Tuliskan hasil yang diharapkan, bukan hanya nama komponen."),
        ("3", "Mention pemilik aksi", "Gunakan @ agar orang atau BrickO yang dituju terlihat jelas."),
        ("4", "Gunakan thread", "Pisahkan investigasi dan follow-up dari timeline utama."),
        ("5", "Jaga keamanan", "Jangan mengirim secret, token, OTP, kredensial, atau data pelanggan."),
        ("6", "Tutup dengan bukti", "Cantumkan hasil test, commit, PR, atau blocker non-secret yang dapat diverifikasi."),
    ]
    rows = []
    for number, label, detail in checklist:
        rows.append(
            [
                Paragraph(number, ParagraphStyle("CheckNumber", parent=CALLOUT, textColor=CORAL, alignment=TA_CENTER)),
                Paragraph(label, CALLOUT),
                Paragraph(detail, BODY),
            ]
        )
    table = Table(rows, colWidths=[12 * mm, 58 * mm, 178 * mm], rowHeights=[18 * mm] * len(rows))
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), WHITE),
                ("BOX", (0, 0), (-1, -1), 0.7, BORDER),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ]
        )
    )
    story.extend([table, Spacer(1, 7 * mm), callout("Butuh bantuan? Mention @BrickO di chat yang tepat dan jelaskan tujuan, konteks, batasan, serta bukti yang sudah tersedia.")])

    doc.build(story, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    build()

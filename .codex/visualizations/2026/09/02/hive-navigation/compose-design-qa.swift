import AppKit

struct Panel {
    let title: String
    let path: String
    let crop: NSRect?
}

func image(at path: String) -> NSImage {
    guard let result = NSImage(contentsOfFile: path) else {
        fatalError("Unable to load \(path)")
    }
    return result
}

func write(_ canvas: NSImage, to path: String) {
    guard let data = canvas.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: data),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        fatalError("Unable to encode \(path)")
    }
    try! png.write(to: URL(fileURLWithPath: path))
}

func drawLabel(_ text: String, at point: NSPoint) {
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 18, weight: .semibold),
        .foregroundColor: NSColor(calibratedWhite: 0.15, alpha: 1),
    ]
    text.draw(at: point, withAttributes: attributes)
}

let root = "/Users/bricko/Work/Hive"
let shots = root + "/web/test-results/smoke-Hive-shows-BrickO-realtime-activity-from-relay-signals-smoke"
let output = root + "/.codex/visualizations/2026/09/02/hive-navigation"
let reference = "/Users/bricko/Work/mantul/sidebar-final-20260705/all-sites/mantap-northstar-top-left.png"

// Focused source-vs-implementation comparison at the same 380x560 crop.
let comparison = NSImage(size: NSSize(width: 800, height: 610))
comparison.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 800, height: 610).fill()
drawLabel("Mantap reference", at: NSPoint(x: 10, y: 580))
drawLabel("Hive implementation", at: NSPoint(x: 410, y: 580))
image(at: reference).draw(in: NSRect(x: 10, y: 10, width: 380, height: 560))
let hiveDesktop = image(at: shots + "/01-desktop-navigation-expanded.png")
hiveDesktop.draw(
    in: NSRect(x: 410, y: 10, width: 380, height: 560),
    from: NSRect(x: 0, y: 160, width: 380, height: 560),
    operation: .sourceOver,
    fraction: 1
)
comparison.unlockFocus()
write(comparison, to: output + "/mantap-vs-hive-navigation.png")

let panels = [
    Panel(title: "Desktop · expanded", path: shots + "/01-desktop-navigation-expanded.png", crop: nil),
    Panel(title: "Desktop · collapsed", path: shots + "/02-desktop-navigation-collapsed.png", crop: nil),
    Panel(title: "Tablet · collapsed", path: shots + "/03-tablet-navigation-collapsed.png", crop: nil),
    Panel(title: "Tablet · expanded", path: shots + "/04-tablet-navigation-expanded.png", crop: nil),
    Panel(title: "Mobile · closed", path: shots + "/05-mobile-navigation-closed.png", crop: nil),
    Panel(title: "Mobile · open", path: shots + "/06-mobile-navigation-open.png", crop: nil),
]

let cell = NSSize(width: 440, height: 500)
let contact = NSImage(size: NSSize(width: cell.width * 3, height: cell.height * 2))
contact.lockFocus()
NSColor(calibratedWhite: 0.96, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: cell.width * 3, height: cell.height * 2).fill()

for (index, panel) in panels.enumerated() {
    let col = index % 3
    let row = index / 3
    let origin = NSPoint(x: CGFloat(col) * cell.width, y: CGFloat(1 - row) * cell.height)
    drawLabel(panel.title, at: NSPoint(x: origin.x + 16, y: origin.y + 466))
    let source = image(at: panel.path)
    let available = NSSize(width: cell.width - 32, height: cell.height - 58)
    let scale = min(available.width / source.size.width, available.height / source.size.height)
    let size = NSSize(width: source.size.width * scale, height: source.size.height * scale)
    let rect = NSRect(
        x: origin.x + (cell.width - size.width) / 2,
        y: origin.y + 12,
        width: size.width,
        height: size.height
    )
    NSColor.white.setFill()
    rect.insetBy(dx: -1, dy: -1).fill()
    source.draw(in: rect)
}

contact.unlockFocus()
write(contact, to: output + "/responsive-navigation-states.png")

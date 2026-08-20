import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Snapshot: Codable {
    let role: String
    let title: String
    let description: String
    let value: String
    let focused: Bool
    let position: [Double]
    let size: [Double]
}

struct Receipt: Codable {
    let status: String
    let mode: String
    let pid: Int32
    let applicationTitle: String
    let windowId: Int
    let adjacentControl: Snapshot
    let focusedCheckbox: Snapshot
    let focusRingBrightPixels: Int
    let selectedCheckbox: Snapshot?
    let selectedHeadingFound: Bool
    let clearSelectionFound: Bool
    let failure: String?
}

enum HarnessError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case let .message(message):
            return message
        }
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 4, let pid = Int32(arguments[1]) else {
    fputs("usage: native_journey.swift <pid> <output-directory> <mode>\n", stderr)
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: arguments[2], isDirectory: true)
let mode = arguments[3]
let application = AXUIElementCreateApplication(pid)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]

func timestamp() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func diagnostic(_ message: String) {
    print("[\(timestamp())] \(message)")
    fflush(stdout)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else {
        return nil
    }
    return result as AnyObject?
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}

func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool {
    attribute(element, name) as? Bool ?? false
}

func pointAttribute(_ element: AXUIElement, _ name: String) -> CGPoint {
    guard let rawValue = attribute(element, name) else {
        return .zero
    }
    let value = rawValue as! AXValue
    var point = CGPoint.zero
    AXValueGetValue(value, .cgPoint, &point)
    return point
}

func sizeAttribute(_ element: AXUIElement, _ name: String) -> CGSize {
    guard let rawValue = attribute(element, name) else {
        return .zero
    }
    let value = rawValue as! AXValue
    var size = CGSize.zero
    AXValueGetValue(value, .cgSize, &size)
    return size
}

func snapshot(_ element: AXUIElement) -> Snapshot {
    let position = pointAttribute(element, kAXPositionAttribute)
    let size = sizeAttribute(element, kAXSizeAttribute)
    return Snapshot(
        role: stringAttribute(element, kAXRoleAttribute),
        title: stringAttribute(element, kAXTitleAttribute),
        description: stringAttribute(element, kAXDescriptionAttribute),
        value: String(describing: attribute(element, kAXValueAttribute) ?? "" as AnyObject),
        focused: boolAttribute(element, kAXFocusedAttribute),
        position: [position.x, position.y],
        size: [size.width, size.height]
    )
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func find(
    _ element: AXUIElement,
    role: String? = nil,
    title: String? = nil,
    titlePrefix: String? = nil,
    focused: Bool? = nil
) -> AXUIElement? {
    let elementRole = stringAttribute(element, kAXRoleAttribute)
    let elementTitle = stringAttribute(element, kAXTitleAttribute)
    let matches =
        (role == nil || elementRole == role) &&
        (title == nil || elementTitle == title) &&
        (titlePrefix == nil || elementTitle.hasPrefix(titlePrefix ?? "")) &&
        (focused == nil || boolAttribute(element, kAXFocusedAttribute) == focused)
    if matches {
        return element
    }
    for child in children(element) {
        if let match = find(
            child,
            role: role,
            title: title,
            titlePrefix: titlePrefix,
            focused: focused
        ) {
            return match
        }
    }
    return nil
}

func waitFor(
    role: String? = nil,
    title: String? = nil,
    titlePrefix: String? = nil,
    focused: Bool? = nil,
    timeout: TimeInterval = 12
) throws -> AXUIElement {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if let match = find(
            application,
            role: role,
            title: title,
            titlePrefix: titlePrefix,
            focused: focused
        ) {
            return match
        }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < deadline
    throw HarnessError.message(
        "timed out waiting for role=\(role ?? "*") title=\(title ?? titlePrefix ?? "*") focused=\(String(describing: focused))"
    )
}

func press(_ element: AXUIElement, label: String) throws {
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard result == .success else {
        throw HarnessError.message("AXPress failed for \(label): \(result.rawValue)")
    }
    diagnostic("AXPress \(label)")
    Thread.sleep(forTimeInterval: 0.7)
}

func focus(_ element: AXUIElement, label: String) throws {
    let result = AXUIElementSetAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    )
    guard result == .success else {
        throw HarnessError.message("AX focus failed for \(label): \(result.rawValue)")
    }
    diagnostic("focused setup control \(label)")
    Thread.sleep(forTimeInterval: 0.8)
}

func key(_ virtualKey: CGKeyCode, label: String) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = [
        "-e", "tell application \"System Events\"",
        "-e", "set frontmost of first application process whose unix id is \(pid) to true",
        "-e", "key code \(virtualKey)",
        "-e", "end tell",
    ]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw HarnessError.message(
            "osascript could not deliver \(label): \(process.terminationStatus)"
        )
    }
    diagnostic("posted macOS HID \(label)")
    Thread.sleep(forTimeInterval: 1.2)
}

func writeJSON<T: Encodable>(_ value: T, to name: String) throws {
    try encoder.encode(value).write(to: outputDirectory.appendingPathComponent(name))
}

func windowId() throws -> Int {
    let windows =
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    for window in windows where window[kCGWindowOwnerPID as String] as? Int32 == pid {
        if let number = window[kCGWindowNumber as String] as? Int {
            return number
        }
    }
    throw HarnessError.message("no onscreen window found for pid \(pid)")
}

func captureScreen(to url: URL) throws -> CGImage {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-D1", url.path]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw HarnessError.message("screencapture failed with \(process.terminationStatus)")
    }
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw HarnessError.message("could not decode screenshot \(url.path)")
    }
    return image
}

func writePNG(_ image: CGImage, to url: URL) throws {
    guard
        let destination = CGImageDestinationCreateWithURL(
            url as CFURL,
            UTType.png.identifier as CFString,
            1,
            nil
        )
    else {
        throw HarnessError.message("could not create PNG destination \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw HarnessError.message("could not write PNG \(url.path)")
    }
}

func brightPixelCount(around element: AXUIElement, screenshot: CGImage) throws -> Int {
    let position = pointAttribute(element, kAXPositionAttribute)
    let size = sizeAttribute(element, kAXSizeAttribute)
    let displayBounds = CGDisplayBounds(CGMainDisplayID())
    let scale = Double(screenshot.width) / displayBounds.width
    let padding = 6.0
    let rect = CGRect(
        x: (position.x - displayBounds.origin.x - padding) * scale,
        y: (position.y - displayBounds.origin.y - padding) * scale,
        width: (size.width + padding * 2) * scale,
        height: (size.height + padding * 2) * scale
    ).integral
    guard let crop = screenshot.cropping(to: rect) else {
        throw HarnessError.message("could not crop checkbox at \(rect)")
    }
    try writePNG(crop, to: outputDirectory.appendingPathComponent("\(mode)-focus-crop.png"))

    let width = crop.width
    let height = crop.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard
        let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else {
        throw HarnessError.message("could not create pixel-analysis context")
    }
    context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
    var count = 0
    for index in stride(from: 0, to: pixels.count, by: 4) {
        let red = Int(pixels[index])
        let green = Int(pixels[index + 1])
        let blue = Int(pixels[index + 2])
        if max(red, green, blue) >= 150 {
            count += 1
        }
    }
    return count
}

func writeFailure(_ message: String, adjacent: Snapshot?, focused: Snapshot?, bright: Int?) {
    let receipt = Receipt(
        status: "failed",
        mode: mode,
        pid: pid,
        applicationTitle: stringAttribute(application, kAXTitleAttribute),
        windowId: (try? windowId()) ?? 0,
        adjacentControl: adjacent ?? Snapshot(
            role: "",
            title: "",
            description: "",
            value: "",
            focused: false,
            position: [],
            size: []
        ),
        focusedCheckbox: focused ?? Snapshot(
            role: "",
            title: "",
            description: "",
            value: "",
            focused: false,
            position: [],
            size: []
        ),
        focusRingBrightPixels: bright ?? 0,
        selectedCheckbox: nil,
        selectedHeadingFound: false,
        clearSelectionFound: false,
        failure: message
    )
    try? writeJSON(receipt, to: "\(mode)-receipt.json")
}

var adjacentSnapshot: Snapshot?
var focusedSnapshot: Snapshot?
var measuredBrightPixels: Int?

do {
    try FileManager.default.createDirectory(
        at: outputDirectory,
        withIntermediateDirectories: true
    )
    let appTitle = stringAttribute(application, kAXTitleAttribute)
    guard appTitle == "Buzz Dev (projects-v6-pt2-selectable-workspaces)" else {
        throw HarnessError.message("unexpected application title: \(appTitle)")
    }
    let nativeWindowId = try windowId()
    diagnostic("application=\(appTitle) pid=\(pid) windowId=\(nativeWindowId) mode=\(mode)")

    let projects = try waitFor(role: kAXButtonRole as String, title: "Projects")
    try press(projects, label: "Projects")
    let tasks = try waitFor(role: kAXCheckBoxRole as String, title: "Tasks")
    try press(tasks, label: "Tasks")
    let listLayout = try waitFor(role: kAXCheckBoxRole as String, title: "List layout")
    try press(listLayout, label: "List layout")

    if let clearSelection = find(application, role: kAXButtonRole as String, title: "Clear selection") {
        try press(clearSelection, label: "Clear selection")
    }

    let adjacent = try waitFor(role: kAXButtonRole as String, titlePrefix: "Open task ")
    try focus(adjacent, label: stringAttribute(adjacent, kAXTitleAttribute))
    adjacentSnapshot = snapshot(adjacent)
    try writeJSON(adjacentSnapshot, to: "\(mode)-adjacent.json")

    try key(48, label: "Tab")
    let focused = try waitFor(role: kAXCheckBoxRole as String, focused: true)
    focusedSnapshot = snapshot(focused)
    try writeJSON(focusedSnapshot, to: "\(mode)-focused.json")
    guard focusedSnapshot?.title.hasPrefix("Select ") == true else {
        throw HarnessError.message("Tab did not reach an entity-specific checkbox")
    }
    guard focusedSnapshot?.value == "0" else {
        throw HarnessError.message("focused checkbox did not start unchecked")
    }

    let focusedScreen = try captureScreen(
        to: outputDirectory.appendingPathComponent("\(mode)-focused-screen.png")
    )
    let brightPixels = try brightPixelCount(around: focused, screenshot: focusedScreen)
    measuredBrightPixels = brightPixels
    diagnostic("focus-ring bright pixels=\(brightPixels)")
    guard brightPixels >= 100 else {
        throw HarnessError.message(
            "visible focus-ring assertion failed: expected >=100 bright pixels, got \(brightPixels)"
        )
    }

    try key(49, label: "Space")
    let selectionDeadline = Date().addingTimeInterval(6)
    var selected = snapshot(focused)
    var selectedHeadingFound = false
    var clearSelectionFound = false
    repeat {
        selected = snapshot(focused)
        selectedHeadingFound =
            find(application, role: kAXHeadingRole as String, title: "1 task") != nil
        clearSelectionFound =
            find(application, role: kAXButtonRole as String, title: "Clear selection") != nil
        if selected.value == "1", selectedHeadingFound, clearSelectionFound {
            break
        }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < selectionDeadline
    try writeJSON(selected, to: "\(mode)-selected.json")
    guard selected.value == "1", selectedHeadingFound, clearSelectionFound else {
        throw HarnessError.message(
            "Space did not produce selected checkbox, 1 task heading, and Clear selection"
        )
    }
    _ = try captureScreen(
        to: outputDirectory.appendingPathComponent("\(mode)-selected-screen.png")
    )

    let receipt = Receipt(
        status: "passed",
        mode: mode,
        pid: pid,
        applicationTitle: appTitle,
        windowId: nativeWindowId,
        adjacentControl: adjacentSnapshot ?? snapshot(adjacent),
        focusedCheckbox: focusedSnapshot ?? snapshot(focused),
        focusRingBrightPixels: brightPixels,
        selectedCheckbox: selected,
        selectedHeadingFound: selectedHeadingFound,
        clearSelectionFound: clearSelectionFound,
        failure: nil
    )
    try writeJSON(receipt, to: "\(mode)-receipt.json")
    diagnostic("PASS native Tab → entity checkbox → visible focus ring → Space selection")
} catch {
    let message = String(describing: error)
    diagnostic("FAIL \(message)")
    writeFailure(
        message,
        adjacent: adjacentSnapshot,
        focused: focusedSnapshot,
        bright: measuredBrightPixels
    )
    exit(1)
}

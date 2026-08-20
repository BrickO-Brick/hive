import Foundation

/// A stable destination attached by the notification service extension after
/// it resolves and verifies the event that produced a push wake.
public struct BuzzPushNavigationTarget: Codable, Equatable, Sendable {
  public static let userInfoKey = "buzz_push_navigation"

  public let eventID: String
  public let communityID: String
  public let channelID: String

  public init(eventID: String, communityID: String, channelID: String) {
    self.eventID = eventID.lowercased()
    self.communityID = communityID
    self.channelID = channelID.lowercased()
  }

  public var userInfoValue: [String: String] {
    [
      "event_id": eventID,
      "community_id": communityID,
      "channel_id": channelID,
    ]
  }

  /// Decodes a target without trusting other fields from the APNs payload.
  public static func decodeIfPresent(
    from userInfo: [AnyHashable: Any]
  ) -> BuzzPushNavigationTarget? {
    guard let raw = userInfo[userInfoKey] as? [String: Any],
      raw.count == 3,
      let eventID = raw["event_id"] as? String,
      let communityID = raw["community_id"] as? String,
      let channelID = raw["channel_id"] as? String,
      !communityID.isEmpty,
      isLowercaseHex64(eventID.lowercased()),
      isChannelID(channelID.lowercased())
    else {
      return nil
    }
    return BuzzPushNavigationTarget(
      eventID: eventID,
      communityID: communityID,
      channelID: channelID
    )
  }

  private static func isLowercaseHex64(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
      }
  }

  private static func isChannelID(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 36,
      bytes[8] == 45, bytes[13] == 45, bytes[18] == 45, bytes[23] == 45,
      [56, 57, 97, 98].contains(bytes[19])
    else { return false }
    return bytes.enumerated().allSatisfy { index, byte in
      if [8, 13, 18, 23].contains(index) { return byte == 45 }
      return (byte >= 48 && byte <= 57) || (byte >= 97 && byte <= 102)
    }
  }
}

/// Thread-safe one-item buffer spanning notification delivery and Flutter
/// engine startup during a cold notification launch.
public final class BuzzPushNavigationBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var target: BuzzPushNavigationTarget?

  public init() {}

  public func record(_ target: BuzzPushNavigationTarget) {
    lock.lock()
    self.target = target
    lock.unlock()
  }

  public func peek() -> BuzzPushNavigationTarget? {
    lock.lock()
    defer { lock.unlock() }
    return target
  }

  public func take() -> BuzzPushNavigationTarget? {
    lock.lock()
    defer { lock.unlock() }
    let current = target
    target = nil
    return current
  }

  public func remove(ifMatching expected: BuzzPushNavigationTarget) {
    lock.lock()
    defer { lock.unlock() }
    if target == expected {
      target = nil
    }
  }
}

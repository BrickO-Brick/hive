import Foundation

/// A stable destination attached by the notification service extension after
/// it resolves and verifies the event that produced a push wake.
public struct BuzzPushNavigationTarget: Codable, Equatable, Sendable {
  public static let userInfoKey = "buzz_push_navigation"

  public let eventID: String
  public let communityID: String
  public let channelID: String

  public init(eventID: String, communityID: String, channelID: String) {
    self.eventID = eventID
    self.communityID = communityID
    self.channelID = channelID
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
      !eventID.isEmpty,
      !communityID.isEmpty,
      !channelID.isEmpty
    else {
      return nil
    }
    return BuzzPushNavigationTarget(
      eventID: eventID,
      communityID: communityID,
      channelID: channelID
    )
  }

}

/// Reply metadata attached only after the NSE has fetched and verified the
/// event behind an opaque push wake-up.
public struct BuzzPushReplyContext: Codable, Equatable, Sendable {
  public static let userInfoKey = "buzz_push_reply"

  public let eventID: String
  public let rootEventID: String
  public let communityID: String
  public let channelID: String
  public let senderPubkey: String
  public let replyKind: Int

  public init(
    eventID: String,
    rootEventID: String,
    communityID: String,
    channelID: String,
    senderPubkey: String,
    replyKind: Int
  ) {
    self.eventID = eventID
    self.rootEventID = rootEventID
    self.communityID = communityID
    self.channelID = channelID
    self.senderPubkey = senderPubkey
    self.replyKind = replyKind
  }

  public var userInfoValue: [String: Any] {
    [
      "event_id": eventID,
      "root_event_id": rootEventID,
      "community_id": communityID,
      "channel_id": channelID,
      "sender_pubkey": senderPubkey,
      "reply_kind": replyKind,
    ]
  }

  public static func decodeIfPresent(from userInfo: [AnyHashable: Any]) -> Self? {
    guard let raw = userInfo[userInfoKey] as? [String: Any], raw.count == 6,
      let eventID = raw["event_id"] as? String, !eventID.isEmpty,
      let rootEventID = raw["root_event_id"] as? String, !rootEventID.isEmpty,
      let communityID = raw["community_id"] as? String, !communityID.isEmpty,
      let channelID = raw["channel_id"] as? String, !channelID.isEmpty,
      let senderPubkey = raw["sender_pubkey"] as? String,
      senderPubkey.count == 64,
      senderPubkey.allSatisfy({ $0.isHexDigit }),
      let replyKind = raw["reply_kind"] as? Int,
      [9, 45_003].contains(replyKind)
    else { return nil }
    return Self(
      eventID: eventID,
      rootEventID: rootEventID,
      communityID: communityID,
      channelID: channelID,
      senderPubkey: senderPubkey.lowercased(),
      replyKind: replyKind
    )
  }
}

public enum BuzzPushNotificationActions {
  public static let messageCategoryIdentifier = "buzz.message"
  public static let replyActionIdentifier = "buzz.reply"
  public static let remindInOneHourActionIdentifier = "buzz.remind.one-hour"
  public static let remindTomorrowActionIdentifier = "buzz.remind.tomorrow"
  public static let remindNextWeekActionIdentifier = "buzz.remind.next-week"
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

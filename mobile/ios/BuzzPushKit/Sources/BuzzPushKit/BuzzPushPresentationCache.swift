import CryptoKit
import Foundation

/// A verified sender profile retained for notification presentation.
public struct BuzzPushCachedProfile: Codable, Equatable, Sendable {
  public let communityID: String
  public let relayOrigin: String
  public let pubkey: String
  public let displayName: String?
  public let pictureHash: String?
  public let avatarPNG: Data?
  public let eventID: String
  public let eventCreatedAt: Int
  public let cachedAt: Int

  public init(
    communityID: String,
    relayOrigin: String,
    pubkey: String,
    displayName: String?,
    pictureHash: String?,
    avatarPNG: Data?,
    eventID: String,
    eventCreatedAt: Int,
    cachedAt: Int
  ) {
    self.communityID = communityID
    self.relayOrigin = relayOrigin
    self.pubkey = pubkey
    self.displayName = displayName
    self.pictureHash = pictureHash
    self.avatarPNG = avatarPNG
    self.eventID = eventID
    self.eventCreatedAt = eventCreatedAt
    self.cachedAt = cachedAt
  }
}

/// Verified channel metadata retained for notification presentation.
public struct BuzzPushCachedChannel: Codable, Equatable, Sendable {
  public let communityID: String
  public let relayOrigin: String
  public let channelID: String
  public let relayMetadataPubkey: String
  public let displayName: String?
  public let eventID: String
  public let eventCreatedAt: Int
  public let cachedAt: Int

  public init(
    communityID: String,
    relayOrigin: String,
    channelID: String,
    relayMetadataPubkey: String,
    displayName: String?,
    eventID: String,
    eventCreatedAt: Int,
    cachedAt: Int
  ) {
    self.communityID = communityID
    self.relayOrigin = relayOrigin
    self.channelID = channelID
    self.relayMetadataPubkey = relayMetadataPubkey
    self.displayName = displayName
    self.eventID = eventID
    self.eventCreatedAt = eventCreatedAt
    self.cachedAt = cachedAt
  }
}

/// Atomic App Group snapshot shared by the app and its notification extension.
public struct BuzzPushPresentationCacheSnapshot: Codable, Equatable, Sendable {
  public static let currentVersion = 1

  public let version: Int
  public var profiles: [BuzzPushCachedProfile]
  public var channels: [BuzzPushCachedChannel]

  public init(
    version: Int = currentVersion,
    profiles: [BuzzPushCachedProfile] = [],
    channels: [BuzzPushCachedChannel] = []
  ) {
    self.version = version
    self.profiles = profiles
    self.channels = channels
  }

  public static func decode(_ data: Data?) -> Self {
    guard let data,
      let snapshot = try? JSONDecoder().decode(Self.self, from: data),
      snapshot.version == currentVersion
    else { return Self() }
    return snapshot
  }

  public func profile(
    communityID: String,
    relayOrigin: String,
    pubkey: String
  ) -> BuzzPushCachedProfile? {
    let normalizedPubkey = pubkey.lowercased()
    return profiles.first {
      $0.communityID == communityID && $0.relayOrigin == relayOrigin
        && $0.pubkey == normalizedPubkey
    }
  }

  public func channel(
    communityID: String,
    relayOrigin: String,
    channelID: String
  ) -> BuzzPushCachedChannel? {
    channels.first {
      $0.communityID == communityID && $0.relayOrigin == relayOrigin
        && $0.channelID == channelID
    }
  }
}

/// One app-provided profile update, optionally carrying a sanitized local thumbnail.
public struct BuzzPushProfileCacheUpdate: Sendable {
  public let event: VerifiedNostrEvent
  public let avatarPNG: Data?

  public init(event: VerifiedNostrEvent, avatarPNG: Data? = nil) {
    self.event = event
    self.avatarPNG = avatarPNG
  }
}

/// Maintains the bounded presentation snapshot. The app is the sole writer.
public final class BuzzPushPresentationCacheStore: @unchecked Sendable {
  public static let fileName = "push-presentation-cache.json"
  public static let freshnessLifetime: TimeInterval = 24 * 60 * 60
  public static let maximumProfiles = 256
  public static let maximumChannels = 512
  public static let maximumAvatarBytes = 64 * 1024
  public static let maximumTotalAvatarBytes = 4 * 1024 * 1024
  public static let maximumSnapshotBytes = 8 * 1024 * 1024

  private let fileURL: URL
  private let now: () -> Date
  private let lock = NSLock()

  public init(containerURL: URL, now: @escaping () -> Date = Date.init) {
    fileURL = containerURL.appendingPathComponent(Self.fileName)
    self.now = now
  }

  /// Saves verified kind-0 events and returns the event IDs still needing thumbnails.
  @discardableResult
  public func updateProfiles(
    communityID: String,
    relayOrigin: String,
    updates: [BuzzPushProfileCacheUpdate]
  ) throws -> Set<String> {
    guard Self.isBoundedOpaqueID(communityID),
      let canonicalRelayOrigin = Self.canonicalRelayOrigin(relayOrigin)
    else { return [] }
    lock.lock()
    defer { lock.unlock() }

    var snapshot = loadLocked()
    let cachedAt = Int(now().timeIntervalSince1970)
    var acceptedEventIDs = Set<String>()
    for update in updates {
      let event = update.event
      guard event.kind == 0, event.hasValidIDAndSignature() else { continue }
      let pubkey = event.pubkey.lowercased()
      guard Self.isHexPubkey(pubkey) else { continue }

      let metadata = Self.profileMetadata(event)
      let index = snapshot.profiles.firstIndex {
        $0.communityID == communityID && $0.relayOrigin == canonicalRelayOrigin
          && $0.pubkey == pubkey
      }
      let existing = index.map { snapshot.profiles[$0] }
      guard Self.shouldReplace(
        existingCreatedAt: existing?.eventCreatedAt,
        existingID: existing?.eventID,
        candidateCreatedAt: event.createdAt,
        candidateID: event.id
      ) else { continue }

      let suppliedAvatar = Self.normalizedAvatarPNG(update.avatarPNG)
      let preservedAvatar = existing?.pictureHash == metadata.pictureHash
        ? existing?.avatarPNG : nil
      let entry = BuzzPushCachedProfile(
        communityID: communityID,
        relayOrigin: canonicalRelayOrigin,
        pubkey: pubkey,
        displayName: metadata.displayName,
        pictureHash: metadata.pictureHash,
        avatarPNG: metadata.pictureHash == nil ? nil : suppliedAvatar ?? preservedAvatar,
        eventID: event.id,
        eventCreatedAt: event.createdAt,
        cachedAt: cachedAt
      )
      if let index {
        snapshot.profiles[index] = entry
      } else {
        snapshot.profiles.append(entry)
      }
      acceptedEventIDs.insert(event.id)
    }

    Self.enforceBounds(&snapshot)
    try writeLocked(snapshot)
    return Set(snapshot.profiles.compactMap { profile in
      guard profile.communityID == communityID,
        profile.relayOrigin == canonicalRelayOrigin,
        acceptedEventIDs.contains(profile.eventID),
        profile.pictureHash != nil,
        profile.avatarPNG == nil
      else { return nil }
      return profile.eventID
    })
  }

  /// Saves signature-verified kind-39000 events for the selected community.
  public func updateChannels(
    communityID: String,
    relayOrigin: String,
    relayMetadataPubkey: String,
    events: [VerifiedNostrEvent]
  ) throws {
    let normalizedRelayPubkey = relayMetadataPubkey.lowercased()
    guard Self.isBoundedOpaqueID(communityID),
      let canonicalRelayOrigin = Self.canonicalRelayOrigin(relayOrigin),
      Self.isHexPubkey(normalizedRelayPubkey)
    else {
      return
    }
    lock.lock()
    defer { lock.unlock() }

    var snapshot = loadLocked()
    let cachedAt = Int(now().timeIntervalSince1970)
    for event in events {
      guard event.kind == 39_000, event.hasValidIDAndSignature(),
        event.pubkey.lowercased() == normalizedRelayPubkey,
        let channelID = Self.tagValue("d", in: event),
        Self.isBoundedOpaqueID(channelID)
      else { continue }
      let index = snapshot.channels.firstIndex {
        $0.communityID == communityID && $0.relayOrigin == canonicalRelayOrigin
          && $0.channelID == channelID
      }
      let existing = index.map { snapshot.channels[$0] }
      guard Self.shouldReplace(
        existingCreatedAt: existing?.eventCreatedAt,
        existingID: existing?.eventID,
        candidateCreatedAt: event.createdAt,
        candidateID: event.id
      ) else { continue }

      let entry = BuzzPushCachedChannel(
        communityID: communityID,
        relayOrigin: canonicalRelayOrigin,
        channelID: channelID,
        relayMetadataPubkey: normalizedRelayPubkey,
        displayName: Self.normalizedDisplayName(Self.tagValue("name", in: event)),
        eventID: event.id,
        eventCreatedAt: event.createdAt,
        cachedAt: cachedAt
      )
      if let index {
        snapshot.channels[index] = entry
      } else {
        snapshot.channels.append(entry)
      }
    }

    Self.enforceBounds(&snapshot)
    try writeLocked(snapshot)
  }

  /// Attaches an app-rendered thumbnail to every verified profile with this source digest.
  @discardableResult
  public func updateAvatar(
    communityID: String,
    relayOrigin: String,
    sourceURL: String,
    avatarPNG: Data
  ) throws -> Bool {
    guard Self.isBoundedOpaqueID(communityID),
      let canonicalRelayOrigin = Self.canonicalRelayOrigin(relayOrigin),
      let normalizedURL = Self.normalizedAvatarURL(sourceURL),
      let normalizedPNG = Self.normalizedAvatarPNG(avatarPNG)
    else { return false }
    let pictureHash = VerifiedNostrEvent.hex(
      SHA256.hash(data: Data(normalizedURL.utf8))
    )
    lock.lock()
    defer { lock.unlock() }

    var snapshot = loadLocked()
    var changed = false
    for index in snapshot.profiles.indices where
      snapshot.profiles[index].communityID == communityID
        && snapshot.profiles[index].relayOrigin == canonicalRelayOrigin
        && snapshot.profiles[index].pictureHash == pictureHash
        && snapshot.profiles[index].avatarPNG != normalizedPNG
    {
      let profile = snapshot.profiles[index]
      snapshot.profiles[index] = BuzzPushCachedProfile(
        communityID: profile.communityID,
        relayOrigin: profile.relayOrigin,
        pubkey: profile.pubkey,
        displayName: profile.displayName,
        pictureHash: profile.pictureHash,
        avatarPNG: normalizedPNG,
        eventID: profile.eventID,
        eventCreatedAt: profile.eventCreatedAt,
        cachedAt: profile.cachedAt
      )
      changed = true
    }
    guard changed else { return false }
    Self.enforceBounds(&snapshot)
    try writeLocked(snapshot)
    return true
  }

  /// Removes metadata belonging to communities no longer present in the app.
  public func retainCommunities(_ communityIDs: Set<String>) throws {
    lock.lock()
    defer { lock.unlock() }
    var snapshot = loadLocked()
    snapshot.profiles.removeAll { !communityIDs.contains($0.communityID) }
    snapshot.channels.removeAll { !communityIDs.contains($0.communityID) }
    try writeLocked(snapshot)
  }

  private func loadLocked() -> BuzzPushPresentationCacheSnapshot {
    guard let values = try? fileURL.resourceValues(forKeys: [.fileSizeKey]),
      let fileSize = values.fileSize,
      fileSize <= Self.maximumSnapshotBytes
    else { return BuzzPushPresentationCacheSnapshot() }
    return BuzzPushPresentationCacheSnapshot.decode(try? Data(contentsOf: fileURL))
  }

  private func writeLocked(_ snapshot: BuzzPushPresentationCacheSnapshot) throws {
    let data = try Self.encodedBoundedSnapshot(snapshot)
    try data.write(to: fileURL, options: [.atomic])
    #if os(iOS)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: fileURL.path
      )
    #endif
  }

  static func encodedBoundedSnapshot(
    _ snapshot: BuzzPushPresentationCacheSnapshot
  ) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    var bounded = snapshot
    Self.enforceBounds(&bounded)
    var data = try encoder.encode(bounded)

    if data.count > Self.maximumSnapshotBytes {
      var estimatedExcess = data.count - Self.maximumSnapshotBytes + 1_024
      for index in bounded.profiles.indices.reversed() {
        guard let avatar = bounded.profiles[index].avatarPNG else { continue }
        estimatedExcess -= min(estimatedExcess, 4 * ((avatar.count + 2) / 3))
        bounded.profiles[index] = Self.removingAvatar(from: bounded.profiles[index])
        if estimatedExcess == 0 { break }
      }
      data = try encoder.encode(bounded)
    }

    while data.count > Self.maximumSnapshotBytes,
      !bounded.profiles.isEmpty || !bounded.channels.isEmpty
    {
      let entryCount = bounded.profiles.count + bounded.channels.count
      let ratio = Double(Self.maximumSnapshotBytes) / Double(data.count)
      let targetCount = max(0, min(entryCount - 1, Int(Double(entryCount) * ratio * 0.95)))
      Self.removeOldestEntries(entryCount - targetCount, from: &bounded)
      data = try encoder.encode(bounded)
    }
    return data
  }

  static func profileMetadata(
    _ event: VerifiedNostrEvent
  ) -> (displayName: String?, pictureHash: String?) {
    guard event.content.utf8.count <= 32 * 1024,
      let data = event.content.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return (nil, nil) }
    let displayName = normalizedDisplayName(object["display_name"] as? String)
      ?? normalizedDisplayName(object["name"] as? String)
    let pictureHash = normalizedAvatarURL(object["picture"] as? String).map {
      VerifiedNostrEvent.hex(SHA256.hash(data: Data($0.utf8)))
    }
    return (displayName, pictureHash)
  }

  static func normalizedDisplayName(_ value: String?) -> String? {
    guard let value else { return nil }
    let collapsed = value.precomposedStringWithCanonicalMapping
      .components(separatedBy: .whitespacesAndNewlines)
      .filter { !$0.isEmpty }
      .joined(separator: " ")
    guard !collapsed.isEmpty else { return nil }
    var bounded = String(collapsed.prefix(128))
    while bounded.utf8.count > 512, !bounded.isEmpty {
      bounded.removeLast()
    }
    return bounded.isEmpty ? nil : bounded
  }

  static func normalizedAvatarURL(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.utf8.count <= 2_048,
      let components = URLComponents(string: trimmed),
      components.user == nil, components.password == nil,
      components.host?.isEmpty == false,
      ["http", "https"].contains(components.scheme?.lowercased() ?? "")
    else { return nil }
    return components.url?.absoluteString
  }

  public static func canonicalRelayOrigin(_ value: String) -> String? {
    guard value.utf8.count <= 2_048,
      var components = URLComponents(string: value),
      components.host?.isEmpty == false,
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      components.path.isEmpty || components.path == "/"
    else { return nil }
    switch components.scheme?.lowercased() {
    case "wss": components.scheme = "https"
    case "ws": components.scheme = "http"
    case "https", "http": break
    default: return nil
    }
    components.path = ""
    guard let result = components.string, result.utf8.count <= 2_048 else { return nil }
    return result
  }

  static func tagValue(_ name: String, in event: VerifiedNostrEvent) -> String? {
    event.tags.first { $0.count >= 2 && $0[0] == name }?[1]
  }

  private static func isBoundedOpaqueID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 1_024
  }

  private static func isHexPubkey(_ value: String) -> Bool {
    value.count == 64 && VerifiedNostrEvent.hexBytes(value)?.count == 32
  }

  private static func normalizedAvatarPNG(_ data: Data?) -> Data? {
    guard let data, !data.isEmpty, data.count <= maximumAvatarBytes,
      data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    else { return nil }
    return data
  }

  static func shouldReplace(
    existingCreatedAt: Int?,
    existingID: String?,
    candidateCreatedAt: Int,
    candidateID: String
  ) -> Bool {
    guard let existingCreatedAt, let existingID else { return true }
    return candidateCreatedAt > existingCreatedAt
      || (candidateCreatedAt == existingCreatedAt && candidateID <= existingID)
  }

  static func enforceBounds(_ snapshot: inout BuzzPushPresentationCacheSnapshot) {
    snapshot.profiles = Array(
      snapshot.profiles.sorted(by: profileNewestFirst).prefix(maximumProfiles)
    )
    snapshot.channels = Array(
      snapshot.channels.sorted(by: channelNewestFirst).prefix(maximumChannels)
    )

    var avatarBytes = snapshot.profiles.reduce(0) { $0 + ($1.avatarPNG?.count ?? 0) }
    guard avatarBytes > maximumTotalAvatarBytes else { return }
    for index in snapshot.profiles.indices.reversed() {
      guard let avatar = snapshot.profiles[index].avatarPNG else { continue }
      avatarBytes -= avatar.count
      let profile = snapshot.profiles[index]
      snapshot.profiles[index] = removingAvatar(from: profile)
      if avatarBytes <= maximumTotalAvatarBytes { break }
    }
  }

  private static func removingAvatar(
    from profile: BuzzPushCachedProfile
  ) -> BuzzPushCachedProfile {
    BuzzPushCachedProfile(
      communityID: profile.communityID,
      relayOrigin: profile.relayOrigin,
      pubkey: profile.pubkey,
      displayName: profile.displayName,
      pictureHash: profile.pictureHash,
      avatarPNG: nil,
      eventID: profile.eventID,
      eventCreatedAt: profile.eventCreatedAt,
      cachedAt: profile.cachedAt
    )
  }

  private static func removeOldestEntries(
    _ count: Int,
    from snapshot: inout BuzzPushPresentationCacheSnapshot
  ) {
    for _ in 0..<count {
      switch (snapshot.profiles.last, snapshot.channels.last) {
      case (nil, nil): return
      case (.some, nil): snapshot.profiles.removeLast()
      case (nil, .some): snapshot.channels.removeLast()
      case (let profile?, let channel?):
        if profile.cachedAt < channel.cachedAt
          || (profile.cachedAt == channel.cachedAt && profile.eventID <= channel.eventID)
        {
          snapshot.profiles.removeLast()
        } else {
          snapshot.channels.removeLast()
        }
      }
    }
  }

  private static func profileNewestFirst(
    _ lhs: BuzzPushCachedProfile,
    _ rhs: BuzzPushCachedProfile
  ) -> Bool {
    lhs.cachedAt == rhs.cachedAt ? lhs.eventID > rhs.eventID : lhs.cachedAt > rhs.cachedAt
  }

  private static func channelNewestFirst(
    _ lhs: BuzzPushCachedChannel,
    _ rhs: BuzzPushCachedChannel
  ) -> Bool {
    lhs.cachedAt == rhs.cachedAt ? lhs.eventID > rhs.eventID : lhs.cachedAt > rhs.cachedAt
  }
}

/// Stable, privacy-preserving identifiers used only after the NSE resolves an event.
public enum BuzzPushPresentationIdentity {
  public static func conversation(communityID: String, channelID: String) -> String {
    scoped(namespace: "conversation", values: [communityID, channelID])
  }

  public static func sender(communityID: String, pubkey: String) -> String {
    scoped(namespace: "sender", values: [communityID, pubkey.lowercased()])
  }

  private static func scoped(namespace: String, values: [String]) -> String {
    let encoded = (try? JSONEncoder().encode([namespace] + values)) ?? Data()
    return "buzz.\(namespace).\(VerifiedNostrEvent.hex(SHA256.hash(data: encoded)))"
  }
}

import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Content resolved from unread Buzz events for a mutable push notification.
public struct BuzzPushResolution: Decodable, Equatable, Sendable {
  public let title: String
  public let body: String
  public let subtitle: String?
  public let threadIdentifier: String?
  public let navigationTarget: BuzzPushNavigationTarget?

  public init(
    title: String,
    body: String,
    subtitle: String?,
    threadIdentifier: String?,
    navigationTarget: BuzzPushNavigationTarget? = nil
  ) {
    self.title = title
    self.body = body
    self.subtitle = subtitle
    self.threadIdentifier = threadIdentifier
    self.navigationTarget = navigationTarget
  }
}

/// Resolves the content used to mutate a generic Buzz push notification.
public protocol BuzzPushNotificationResolving {
  func resolve(completion: @escaping (BuzzPushResolution?) -> Void)
}

/// Reads configured Buzz communities and resolves their newest unread event.
public final class BuzzPushNotificationResolver: BuzzPushNotificationResolving {
  private let session: URLSession
  private let loadCommunitiesData: () -> Data?
  private let loadPrivateKey: (String) -> String?

  /// Creates a resolver around the notification extension's App Group and Keychain I/O.
  public init(
    session: URLSession,
    loadCommunitiesData: @escaping () -> Data?,
    loadPrivateKey: @escaping (String) -> String?
  ) {
    self.session = session
    self.loadCommunitiesData = loadCommunitiesData
    self.loadPrivateKey = loadPrivateKey
  }

  public func resolve(completion: @escaping (BuzzPushResolution?) -> Void) {
    let communities = loadCommunities().filter {
      $0.pubkey?.isEmpty == false
        && loadPrivateKey($0.id) != nil
        && (try? $0.pushSubscriptionState.authoritativeSubscriptions().isEmpty == false) == true
    }
    guard !communities.isEmpty else {
      completion(nil)
      return
    }
    let group = DispatchGroup()
    let lock = NSLock()
    var candidates: [(BuzzPushResolution, VerifiedNostrEvent)] = []
    for community in communities {
      group.enter()
      query(community) { candidate in
        if let candidate {
          lock.lock()
          candidates.append(candidate)
          lock.unlock()
        }
        group.leave()
      }
    }
    group.notify(queue: .global(qos: .userInitiated)) {
      let newest = candidates.max {
        $0.1.createdAt == $1.1.createdAt ? $0.1.id > $1.1.id : $0.1.createdAt < $1.1.createdAt
      }
      completion(newest?.0)
    }
  }

  private func query(
    _ community: PushLeaseCommunity,
    completion: @escaping ((BuzzPushResolution, VerifiedNostrEvent)?) -> Void
  ) {
    guard let privateKey = loadPrivateKey(community.id), community.pubkey?.isEmpty == false else {
      completion(nil)
      return
    }
    guard
      let subscriptions = try? community.pushSubscriptionState.authoritativeSubscriptions(),
      !subscriptions.isEmpty,
      let relayURL = community.relayURL,
      let url = URL(string: "/query", relativeTo: relayURL),
      let body = try? JSONSerialization.data(
        withJSONObject: subscriptions.map { $0.filter.queryFilter(since: nil, limit: 10) }
      )
    else {
      completion(nil)
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = body
    request.timeoutInterval = 8
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    guard
      let auth = try? NostrHTTPAuth.authorizationHeader(
        url: url, method: "POST", body: body, privateKeyHex: privateKey
      )
    else {
      completion(nil)
      return
    }
    request.setValue(auth, forHTTPHeaderField: "Authorization")
    session.dataTask(with: request) { data, response, _ in
      guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
        let data, let events = try? JSONDecoder().decode([VerifiedNostrEvent].self, from: data)
      else {
        completion(nil)
        return
      }
      completion(
        Self.decodeResolution(
          events: events.filter { event in
            event.hasValidIDAndSignature()
              && subscriptions.contains { subscription in
                PushLeaseMatcher.matches(event: event, subscription: subscription)
              }
          },
          community: community
        ))
    }.resume()
  }

  static func decodeResolution(
    events: [VerifiedNostrEvent], community: PushLeaseCommunity
  ) -> (BuzzPushResolution, VerifiedNostrEvent)? {
    guard let mine = community.pubkey?.lowercased() else { return nil }
    let event = events.filter {
      $0.pubkey.lowercased() != mine && [9, 40002, 45001, 45003].contains($0.kind)
    }.sorted {
      $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt > $1.createdAt
    }.first
    guard let event else { return nil }
    let body = previewBody(event.content)
    guard !body.isEmpty else { return nil }
    let channel = event.tags.first { $0.count >= 2 && $0[0] == "h" }?[1]
    return (
      BuzzPushResolution(
        title: shortPubkey(event.pubkey), body: body, subtitle: community.name,
        threadIdentifier: channel ?? community.id,
        navigationTarget: channel.map {
          BuzzPushNavigationTarget(
            eventID: event.id,
            communityID: community.id,
            channelID: $0
          )
        }
      ), event
    )
  }

  static func previewBody(_ content: String) -> String {
    var result = content.replacingOccurrences(
      of: #"```[\s\S]*?```"#, with: "[code]", options: .regularExpression)
    result = result.replacingOccurrences(of: #"`([^`]*)`"#, with: "$1", options: .regularExpression)
    result = result.replacingOccurrences(
      of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
    result = result.replacingOccurrences(
      of: #"https?://\S+"#, with: "[link]", options: .regularExpression)
    result = result.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return result.count > 180
      ? String(result.prefix(177)).trimmingCharacters(in: .whitespacesAndNewlines) + "…" : result
  }

  static func shortPubkey(_ pubkey: String) -> String {
    pubkey.count > 8 ? String(pubkey.prefix(8)) + "…" : pubkey
  }

  private func loadCommunities() -> [PushLeaseCommunity] {
    guard let data = loadCommunitiesData(),
      let decoded = try? JSONDecoder().decode(PushLeaseSnapshot.self, from: data)
    else { return [] }
    return decoded.communities
  }
}

extension PushLeaseCommunity {
  var relayURL: URL? {
    guard var components = URLComponents(string: relayUrl),
      components.host?.isEmpty == false,
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      components.path.isEmpty || components.path == "/"
    else { return nil }
    components.scheme =
      switch components.scheme?.lowercased() {
      case "wss": "https"
      case "ws": "http"
      case "https": "https"
      case "http": "http"
      default: nil
      }
    components.path = ""
    return components.url
  }
}

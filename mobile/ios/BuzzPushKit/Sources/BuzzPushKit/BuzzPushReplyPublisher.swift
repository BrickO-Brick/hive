import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public enum BuzzPushReplyError: Error, Equatable {
  case emptyContent
  case contentTooLarge
  case invalidRelayURL
  case rejected
}

/// Publishes a notification text reply over the relay's authenticated HTTP bridge.
public final class BuzzPushReplyPublisher: @unchecked Sendable {
  public static let maximumContentBytes = 4_096

  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func publish(
    context: BuzzPushReplyContext,
    content: String,
    relayURL: URL,
    privateKeyHex: String,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      completion(.failure(BuzzPushReplyError.emptyContent))
      return
    }
    guard trimmed.utf8.count <= Self.maximumContentBytes else {
      completion(.failure(BuzzPushReplyError.contentTooLarge))
      return
    }
    guard let eventsURL = Self.eventsURL(from: relayURL) else {
      completion(.failure(BuzzPushReplyError.invalidRelayURL))
      return
    }

    let threadTags: [[String]] =
      context.rootEventID == context.eventID
      ? [["e", context.eventID, "", "reply"]]
      : [
        ["e", context.rootEventID, "", "root"],
        ["e", context.eventID, "", "reply"],
      ]
    let tags =
      [
        ["p", context.senderPubkey],
        ["h", context.channelID],
      ] + threadTags

    do {
      let event = try BuzzNostrEventSigner.sign(
        kind: context.replyKind,
        tags: tags,
        content: trimmed,
        privateKeyHex: privateKeyHex
      )
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.withoutEscapingSlashes]
      let body = try encoder.encode(event)
      var request = URLRequest(url: eventsURL)
      request.httpMethod = "POST"
      request.httpBody = body
      request.timeoutInterval = 10
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue(
        try NostrHTTPAuth.authorizationHeader(
          url: eventsURL,
          method: "POST",
          body: body,
          privateKeyHex: privateKeyHex
        ),
        forHTTPHeaderField: "Authorization"
      )
      session.dataTask(with: request) { data, response, error in
        if let error {
          completion(.failure(error))
          return
        }
        guard let response = response as? HTTPURLResponse,
          (200..<300).contains(response.statusCode),
          let data,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["accepted"] as? Bool == true,
          object["event_id"] as? String == event.id
        else {
          completion(.failure(BuzzPushReplyError.rejected))
          return
        }
        completion(.success(event.id))
      }.resume()
    } catch {
      completion(.failure(error))
    }
  }

  static func eventsURL(from relayURL: URL) -> URL? {
    guard var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false),
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
    components.path = "/events"
    return components.url
  }
}

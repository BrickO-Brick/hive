import Foundation
import XCTest

@testable import BuzzPushKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

final class BuzzPushReplyPublisherTests: XCTestCase {
  private let privateKey = String(repeating: "0", count: 63) + "1"

  override func tearDown() {
    ReplyURLProtocol.handler = nil
    super.tearDown()
  }

  func testPublishesSignedNestedReplyToExactChannelAndThread() throws {
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.protocolClasses = [ReplyURLProtocol.self]
    let publisher = BuzzPushReplyPublisher(
      session: URLSession(configuration: sessionConfiguration)
    )
    let context = BuzzPushReplyContext(
      eventID: "parent-id",
      rootEventID: "root-id",
      communityID: "community-id",
      channelID: "channel/general:v5",
      senderPubkey: String(repeating: "a", count: 64),
      replyKind: 9
    )
    let completed = expectation(description: "published")

    ReplyURLProtocol.handler = { request in
      XCTAssertEqual(request.url?.absoluteString, "https://relay.example/events")
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertNotNil(request.value(forHTTPHeaderField: "Authorization"))
      let requestBody = try XCTUnwrap(Self.body(from: request))
      let event = try JSONDecoder().decode(
        VerifiedNostrEvent.self,
        from: requestBody
      )
      XCTAssertTrue(event.hasValidIDAndSignature())
      XCTAssertEqual(event.kind, 9)
      XCTAssertEqual(event.content, "Reply from lock screen")
      XCTAssertEqual(
        event.tags,
        [
          ["p", String(repeating: "a", count: 64)],
          ["h", "channel/general:v5"],
          ["e", "root-id", "", "root"],
          ["e", "parent-id", "", "reply"],
        ])
      let response = try XCTUnwrap(
        HTTPURLResponse(
          url: request.url!,
          statusCode: 200,
          httpVersion: nil,
          headerFields: nil
        )
      )
      let body = try JSONSerialization.data(withJSONObject: [
        "event_id": event.id,
        "accepted": true,
        "message": "",
      ])
      return (response, body)
    }

    publisher.publish(
      context: context,
      content: "  Reply from lock screen  ",
      relayURL: URL(string: "wss://relay.example")!,
      privateKeyHex: privateKey
    ) { result in
      switch result {
      case .success:
        break
      case .failure(let error):
        XCTFail("Reply publish failed: \(error)")
      }
      completed.fulfill()
    }

    wait(for: [completed], timeout: 1)
  }

  func testRejectsEmptyAndOversizedRepliesWithoutNetwork() {
    let publisher = BuzzPushReplyPublisher()
    let context = BuzzPushReplyContext(
      eventID: "event",
      rootEventID: "event",
      communityID: "community",
      channelID: "channel",
      senderPubkey: String(repeating: "a", count: 64),
      replyKind: 9
    )
    var errors: [BuzzPushReplyError] = []

    publisher.publish(
      context: context,
      content: " \n ",
      relayURL: URL(string: "https://relay.example")!,
      privateKeyHex: privateKey
    ) { result in
      if case .failure(let error as BuzzPushReplyError) = result { errors.append(error) }
    }
    publisher.publish(
      context: context,
      content: String(repeating: "x", count: BuzzPushReplyPublisher.maximumContentBytes + 1),
      relayURL: URL(string: "https://relay.example")!,
      privateKeyHex: privateKey
    ) { result in
      if case .failure(let error as BuzzPushReplyError) = result { errors.append(error) }
    }

    XCTAssertEqual(errors, [.emptyContent, .contentTooLarge])
  }

  private static func body(from request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count > 0 else { break }
      data.append(buffer, count: count)
    }
    return data
  }
}

private final class ReplyURLProtocol: URLProtocol, @unchecked Sendable {
  static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    do {
      let (response, data) =
        try Self.handler?(request)
        ?? {
          throw URLError(.unsupportedURL)
        }()
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

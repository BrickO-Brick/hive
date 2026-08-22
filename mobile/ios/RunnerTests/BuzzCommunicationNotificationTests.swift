import BuzzPushKit
import Intents
import UserNotifications
import XCTest

@testable import Buzz

final class BuzzCommunicationNotificationTests: XCTestCase {
  func testIntentUsesVerifiedSenderAvatarAndGroupName() throws {
    let resolution = communicationResolution(
      displayName: "Alice",
      groupName: "General",
      avatarPNG: Data([0x89, 0x50, 0x4E, 0x47])
    )
    let descriptor = try XCTUnwrap(
      BuzzCommunicationNotificationDescriptor(resolution: resolution)
    )

    let intent = BuzzCommunicationNotificationPresenter.makeIntent(descriptor)

    XCTAssertEqual(intent.sender?.displayName, "Alice")
    XCTAssertEqual(intent.sender?.customIdentifier, descriptor.senderIdentifier)
    XCTAssertNotNil(intent.sender?.image)
    XCTAssertEqual(intent.content, "Hello Buzz")
    XCTAssertEqual(intent.speakableGroupName?.spokenPhrase, "General")
    XCTAssertEqual(intent.conversationIdentifier, resolution.conversationIdentifier)
    XCTAssertNil(intent.recipients)
  }

  func testPresentationFallsBackWhenDonationFails() {
    let ordinary = UNMutableNotificationContent()
    ordinary.title = "Alice"
    ordinary.body = "Hello Buzz"
    var updateCalled = false
    let presenter = BuzzCommunicationNotificationPresenter(
      donate: { _, completion in
        completion(NSError(domain: "test", code: 1))
      },
      updateContent: { content, _ in
        updateCalled = true
        return content
      }
    )
    let completed = expectation(description: "ordinary fallback returned")

    presenter.present(
      ordinaryContent: ordinary,
      resolution: communicationResolution()
    ) { content in
      XCTAssertEqual(content.title, "Alice")
      XCTAssertEqual(content.body, "Hello Buzz")
      completed.fulfill()
    }

    wait(for: [completed], timeout: 1)
    XCTAssertFalse(updateCalled)
  }

  func testPresentationDonatesBeforeSpecializing() {
    let ordinary = UNMutableNotificationContent()
    ordinary.title = "Alice"
    var order: [String] = []
    let presenter = BuzzCommunicationNotificationPresenter(
      donate: { _, completion in
        order.append("donate")
        completion(nil)
      },
      updateContent: { _, _ in
        order.append("update")
        let specialized = UNMutableNotificationContent()
        specialized.title = "specialized"
        return specialized
      }
    )
    let completed = expectation(description: "specialized content returned")

    presenter.present(
      ordinaryContent: ordinary,
      resolution: communicationResolution()
    ) { content in
      XCTAssertEqual(content.title, "specialized")
      completed.fulfill()
    }

    wait(for: [completed], timeout: 1)
    XCTAssertEqual(order, ["donate", "update"])
  }

  func testPresentationFallsBackWhenSpecializationFails() {
    let ordinary = UNMutableNotificationContent()
    ordinary.title = "Alice"
    ordinary.body = "Hello Buzz"
    let presenter = BuzzCommunicationNotificationPresenter(
      donate: { _, completion in completion(nil) },
      updateContent: { _, _ in throw NSError(domain: "test", code: 2) }
    )
    let completed = expectation(description: "ordinary fallback returned")

    presenter.present(
      ordinaryContent: ordinary,
      resolution: communicationResolution()
    ) { content in
      XCTAssertEqual(content.title, "Alice")
      XCTAssertEqual(content.body, "Hello Buzz")
      completed.fulfill()
    }

    wait(for: [completed], timeout: 1)
  }

  private func communicationResolution(
    displayName: String = "Alice",
    groupName: String? = "General",
    avatarPNG: Data? = nil
  ) -> BuzzPushResolution {
    let communityID = "community-id"
    let channelID = "channel/general:v5"
    return BuzzPushResolution(
      title: displayName,
      body: "Hello Buzz",
      subtitle: "Community",
      threadIdentifier: BuzzPushPresentationIdentity.conversation(
        communityID: communityID,
        channelID: channelID
      ),
      navigationTarget: BuzzPushNavigationTarget(
        eventID: "message-id",
        communityID: communityID,
        channelID: channelID
      ),
      senderPubkey: String(repeating: "a", count: 64),
      senderAvatarPNG: avatarPNG,
      conversationIdentifier: BuzzPushPresentationIdentity.conversation(
        communityID: communityID,
        channelID: channelID
      ),
      conversationDisplayName: groupName
    )
  }
}

final class BuzzPushSnapshotEnrichmentTests: XCTestCase {
  func testMetadataAuthorityUsesCurrentAppProfileForMatchingRelay() {
    let correctProfile = grant(
      appProfile: BuzzDevPushEnrollmentDriver.appProfile,
      generation: 2,
      metadataPubkey: String(repeating: "a", count: 64)
    )
    let wrongProfile = grant(
      appProfile: "buzz-ios-app-store",
      generation: 99,
      metadataPubkey: String(repeating: "b", count: 64)
    )

    XCTAssertEqual(
      AppDelegate.pushRelayMetadataPubkey(
        relayURL: "wss://relay.example/",
        grants: [wrongProfile, correctProfile]
      ),
      correctProfile.relayMetadataPubkey
    )
  }

  private func grant(
    appProfile: String,
    generation: Int64,
    metadataPubkey: String
  ) -> BuzzPushEndpointGrantRecord {
    BuzzPushEndpointGrantRecord(
      relayOrigin: "https://relay.example",
      relayPubkey: String(repeating: "c", count: 64),
      relayMetadataPubkey: metadataPubkey,
      installationId: "installation",
      endpointGrant: "opaque-grant",
      endpointHash: String(repeating: "d", count: 64),
      appProfile: appProfile,
      endpointEpoch: 1,
      generation: generation,
      expiresAt: 1_900_000_000
    )
  }
}

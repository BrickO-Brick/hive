import Foundation
import Testing

@testable import BuzzPushKit

@Test func `Round-trip opaque navigation target through notification user info`() {
  let target = BuzzPushNavigationTarget(
    eventID: "MESSAGE-ID",
    communityID: "community-id",
    channelID: "CHANNEL/GENERAL"
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [BuzzPushNavigationTarget.userInfoKey: target.userInfoValue]
    ) == target
  )
  #expect(target.eventID == "MESSAGE-ID")
  #expect(target.channelID == "CHANNEL/GENERAL")
}

@Test func `Reject incomplete or malformed navigation target`() {
  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": "message-id",
          "community_id": "community-id",
        ]
      ]
    ) == nil
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": "",
          "community_id": "community-id",
          "channel_id": "channel-id",
        ]
      ]
    ) == nil
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": "message-id",
          "community_id": "community-id",
          "channel_id": "",
        ]
      ]
    ) == nil
  )
}

@Test func `Buffer preserves cold-start target until consumed`() {
  let first = BuzzPushNavigationTarget(
    eventID: String(repeating: "a", count: 64),
    communityID: "community-id",
    channelID: "123e4567-e89b-42d3-a456-426614174000"
  )
  let second = BuzzPushNavigationTarget(
    eventID: String(repeating: "b", count: 64),
    communityID: "community-id",
    channelID: "123e4567-e89b-42d3-a456-426614174000"
  )
  let buffer = BuzzPushNavigationBuffer()

  buffer.record(first)
  buffer.remove(ifMatching: second)
  #expect(buffer.peek() == first)
  #expect(buffer.take() == first)
  #expect(buffer.take() == nil)
}

@Test func `Round-trip verified reply context and reject malformed values`() {
  let context = BuzzPushReplyContext(
    eventID: "message-id",
    rootEventID: "root-id",
    communityID: "community-id",
    channelID: "opaque/channel",
    senderPubkey: String(repeating: "A", count: 64),
    replyKind: 9
  )

  #expect(
    BuzzPushReplyContext.decodeIfPresent(
      from: [BuzzPushReplyContext.userInfoKey: context.userInfoValue]
    )
      == BuzzPushReplyContext(
        eventID: "message-id",
        rootEventID: "root-id",
        communityID: "community-id",
        channelID: "opaque/channel",
        senderPubkey: String(repeating: "a", count: 64),
        replyKind: 9
      )
  )

  var malformed = context.userInfoValue
  malformed["sender_pubkey"] = "not-a-pubkey"
  #expect(
    BuzzPushReplyContext.decodeIfPresent(
      from: [BuzzPushReplyContext.userInfoKey: malformed]
    ) == nil
  )
  malformed = context.userInfoValue
  malformed["reply_kind"] = 1
  #expect(
    BuzzPushReplyContext.decodeIfPresent(
      from: [BuzzPushReplyContext.userInfoKey: malformed]
    ) == nil
  )
}

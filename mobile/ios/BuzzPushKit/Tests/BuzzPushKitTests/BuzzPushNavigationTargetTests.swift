import Foundation
import Testing

@testable import BuzzPushKit

@Test func `Round-trip UUIDv4 navigation target through notification user info`() {
  let target = BuzzPushNavigationTarget(
    eventID: String(repeating: "A", count: 64),
    communityID: "community-id",
    channelID: "123E4567-E89B-42D3-A456-426614174000"
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [BuzzPushNavigationTarget.userInfoKey: target.userInfoValue]
    ) == target
  )
  #expect(target.eventID == String(repeating: "a", count: 64))
  #expect(target.channelID == "123e4567-e89b-42d3-a456-426614174000")
}

@Test func `Decode UUIDv5 navigation target`() {
  let target = BuzzPushNavigationTarget(
    eventID: String(repeating: "B", count: 64),
    communityID: "community-id",
    channelID: "9A1657AC-F7AA-5DB0-B632-D8BBEB6DFB50"
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [BuzzPushNavigationTarget.userInfoKey: target.userInfoValue]
    ) == target
  )
  #expect(target.channelID == "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50")
}

@Test func `Reject incomplete or malformed navigation target`() {
  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": "event-id",
          "community_id": "community-id",
        ]
      ]
    ) == nil
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": String(repeating: "a", count: 64),
          "community_id": "community-id",
          "channel_id": "not-a-channel",
        ]
      ]
    ) == nil
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": String(repeating: "a", count: 64),
          "community_id": "community-id",
          "channel_id": "9a1657ac-f7aa-5db0-7632-d8bbeb6dfb50",
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

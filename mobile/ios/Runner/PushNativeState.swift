import BuzzPushKit
import Foundation
import Security
import UserNotifications

final class BuzzOneShotCompletion {
  private let lock = NSLock()
  private var completion: (() -> Void)?

  init(_ completion: @escaping () -> Void) {
    self.completion = completion
  }

  func call() {
    lock.lock()
    let completion = completion
    self.completion = nil
    lock.unlock()
    guard let completion else { return }
    if Thread.isMainThread {
      completion()
    } else {
      // Reply publication finishes on a URLSession callback queue, while the
      // notification response completion crosses back into UIKit.
      DispatchQueue.main.async(execute: completion)
    }
  }
}

enum BuzzPushNotificationResponseCoordinator {
  static func handle(
    actionIdentifier: String,
    userInfo: [AnyHashable: Any],
    textInput: String? = nil,
    onTarget: (BuzzPushNavigationTarget) -> Void,
    onReply: (
      (BuzzPushReplyContext, String, @escaping () -> Void) -> Void
    )? = nil,
    onReminder: ((BuzzPushReplyContext) -> Void)? = nil,
    forwardToFlutter: (@escaping () -> Void) -> Void,
    completion: @escaping () -> Void
  ) {
    let completionGate = BuzzOneShotCompletion(completion)

    if actionIdentifier == BuzzPushNotificationActions.replyActionIdentifier,
      let textInput,
      let context = BuzzPushReplyContext.decodeIfPresent(from: userInfo),
      let onReply
    {
      onReply(context, textInput) { completionGate.call() }
      return
    }

    if actionIdentifier == BuzzPushNotificationActions.remindActionIdentifier,
      let context = BuzzPushReplyContext.decodeIfPresent(from: userInfo),
      let onReminder
    {
      onReminder(context)
      completionGate.call()
      return
    }

    if actionIdentifier == UNNotificationDefaultActionIdentifier,
      let target = BuzzPushNavigationTarget.decodeIfPresent(from: userInfo)
    {
      onTarget(target)
    }
    forwardToFlutter { completionGate.call() }
    completionGate.call()
  }
}

enum BuzzPushNotificationCategoryRegistrar {
  static func register(with center: UNUserNotificationCenter) {
    let reply = UNTextInputNotificationAction(
      identifier: BuzzPushNotificationActions.replyActionIdentifier,
      title: "Reply",
      options: [],
      textInputButtonTitle: "Send",
      textInputPlaceholder: "Reply to Buzz"
    )
    let remind = UNNotificationAction(
      identifier: BuzzPushNotificationActions.remindActionIdentifier,
      title: "Remind me",
      options: [.foreground]
    )
    center.setNotificationCategories([
      UNNotificationCategory(
        identifier: BuzzPushNotificationActions.messageCategoryIdentifier,
        actions: [reply, remind],
        intentIdentifiers: [],
        options: []
      )
    ])
  }
}

struct BuzzPushReminderRequest: Equatable {
  let context: BuzzPushReplyContext
  let preview: String

  var flutterArguments: [String: Any] {
    [
      "eventId": context.eventID,
      "communityId": context.communityID,
      "channelId": context.channelID,
      "authorPubkey": context.senderPubkey,
      "preview": preview,
    ]
  }
}

final class BuzzPushReminderBuffer {
  private let lock = NSLock()
  private var request: BuzzPushReminderRequest?

  func record(_ request: BuzzPushReminderRequest) {
    lock.lock()
    self.request = request
    lock.unlock()
  }

  func take() -> BuzzPushReminderRequest? {
    lock.lock()
    defer { lock.unlock() }
    let current = request
    request = nil
    return current
  }

  func remove(ifMatching expected: BuzzPushReminderRequest) {
    lock.lock()
    defer { lock.unlock() }
    if request == expected { request = nil }
  }
}

enum BuzzPushKeychain {
  static let service = "buzz.push.nse.signing"

  static func replace(signingKeys: [String: String], accessGroup: String?) throws {
    var query = baseQuery(accessGroup: accessGroup)
    SecItemDelete(query as CFDictionary)
    for (communityID, privateKeyHex) in signingKeys {
      query[kSecAttrAccount as String] = communityID
      query[kSecValueData as String] = Data(privateKeyHex.utf8)
      query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      let status = SecItemAdd(query as CFDictionary, nil)
      guard status == errSecSuccess else {
        SecItemDelete(baseQuery(accessGroup: accessGroup) as CFDictionary)
        throw NSError(
          domain: NSOSStatusErrorDomain, code: Int(status),
          userInfo: [
            NSLocalizedDescriptionKey: SecCopyErrorMessageString(status, nil)
              ?? "Keychain write failed" as CFString
          ]
        )
      }
      query.removeValue(forKey: kSecValueData as String)
      query.removeValue(forKey: kSecAttrAccessible as String)
      query.removeValue(forKey: kSecAttrAccount as String)
    }
  }

  static func signingKey(communityID: String, accessGroup: String?) -> String? {
    var query = baseQuery(accessGroup: accessGroup)
    query[kSecAttrAccount as String] = communityID
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private static func baseQuery(accessGroup: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
    ]
    if let accessGroup, !accessGroup.isEmpty {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    return query
  }
}

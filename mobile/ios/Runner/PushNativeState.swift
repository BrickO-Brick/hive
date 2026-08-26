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
    onReminder: (
      (BuzzPushReplyContext, BuzzPushReminderPreset, @escaping () -> Void) -> Void
    )? = nil,
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

    if let preset = BuzzPushReminderPreset(actionIdentifier: actionIdentifier),
      let context = BuzzPushReplyContext.decodeIfPresent(from: userInfo),
      let onReminder
    {
      onReminder(context, preset) { completionGate.call() }
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
    let reminderActions = BuzzPushReminderPreset.allCases.map { preset in
      UNNotificationAction(
        identifier: preset.actionIdentifier,
        title: preset.actionTitle,
        options: []
      )
    }
    center.setNotificationCategories([
      UNNotificationCategory(
        identifier: BuzzPushNotificationActions.messageCategoryIdentifier,
        actions: [reply] + reminderActions,
        intentIdentifiers: [],
        options: []
      )
    ])
  }
}

enum BuzzPushReminderPreset: CaseIterable, Equatable {
  case oneHour
  case tomorrowAt9AM
  case nextMondayAt9AM

  init?(actionIdentifier: String) {
    switch actionIdentifier {
    case BuzzPushNotificationActions.remindInOneHourActionIdentifier:
      self = .oneHour
    case BuzzPushNotificationActions.remindTomorrowActionIdentifier:
      self = .tomorrowAt9AM
    case BuzzPushNotificationActions.remindNextWeekActionIdentifier:
      self = .nextMondayAt9AM
    default:
      return nil
    }
  }

  var actionIdentifier: String {
    switch self {
    case .oneHour: BuzzPushNotificationActions.remindInOneHourActionIdentifier
    case .tomorrowAt9AM: BuzzPushNotificationActions.remindTomorrowActionIdentifier
    case .nextMondayAt9AM: BuzzPushNotificationActions.remindNextWeekActionIdentifier
    }
  }

  var actionTitle: String {
    switch self {
    case .oneHour: "Remind Me in 1 Hour"
    case .tomorrowAt9AM: "Remind Me Tomorrow at 9 AM"
    case .nextMondayAt9AM: "Remind Me Next Monday at 9 AM"
    }
  }

  func fireDate(now: Date, calendar: Calendar) -> Date? {
    switch self {
    case .oneHour:
      return now.addingTimeInterval(60 * 60)
    case .tomorrowAt9AM:
      guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) else {
        return nil
      }
      return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow)
    case .nextMondayAt9AM:
      let weekday = calendar.component(.weekday, from: now)
      let monday = 2
      let daysUntilMonday = ((monday - weekday + 7) % 7) + (weekday == monday ? 7 : 0)
      guard let nextMonday = calendar.date(
        byAdding: .day,
        value: daysUntilMonday,
        to: now
      ) else { return nil }
      return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: nextMonday)
    }
  }
}

enum BuzzPushReminderScheduler {
  // Temporary demo behavior: each action schedules a local copy of the rich
  // notification without foregrounding Buzz. The canonical in-app reminder
  // flow continues to publish its cross-client kind-30300 event separately.
  static func schedule(
    with center: UNUserNotificationCenter,
    originalContent: UNNotificationContent,
    preset: BuzzPushReminderPreset,
    now: Date = Date(),
    calendar: Calendar = .current,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    guard let fireDate = preset.fireDate(now: now, calendar: calendar) else {
      completion(.failure(BuzzPushReminderError.invalidFireDate))
      return
    }
    let content = originalContent.mutableCopy() as? UNMutableNotificationContent
    guard let content else {
      completion(.failure(BuzzPushReminderError.invalidContent))
      return
    }
    let components = calendar.dateComponents(
      [.year, .month, .day, .hour, .minute, .second],
      from: fireDate
    )
    let request = UNNotificationRequest(
      identifier: "buzz.reminder.\(UUID().uuidString)",
      content: content,
      trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
    )
    center.add(request) { error in
      if let error {
        completion(.failure(error))
      } else {
        completion(.success(()))
      }
    }
  }
}

enum BuzzPushReminderError: Error {
  case invalidContent
  case invalidFireDate
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

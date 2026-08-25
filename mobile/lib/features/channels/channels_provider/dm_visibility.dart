part of '../channels_provider.dart';

mixin _DmVisibilitySubscription on AsyncNotifier<List<Channel>> {
  void Function()? _unsubscribeDmVisibility;
  String? _dmVisibilityRelayBaseUrl;
  String? _dmVisibilityPubkey;
  // Id of the last visibility snapshot we acted on. The `limit: 1` filter
  // replays the latest stored kind:30622 snapshot on every (re)subscribe; if
  // that replay fires before `subscribe()` resolves, `refresh()` bumps the
  // subscription version, retires this install, and the next queued sync
  // re-subscribes and replays the identical snapshot again — an unbounded
  // refresh/subscribe loop for any user with an existing snapshot. Snapshots
  // are parameterized-replaceable, so the stored event keeps a stable id;
  // suppressing a re-delivered identical id breaks that loop while a genuinely
  // new snapshot (new id) still triggers exactly one refresh.
  String? _lastHandledDmVisibilityEventId;

  int get _subscriptionVersion;

  Future<void> refresh();

  Future<void> _syncDmVisibilitySubscription(
    String relayBaseUrl,
    int subscriptionVersion,
    _ChannelRefreshFence fence,
    RelaySessionNotifier session,
    String? myPk,
  ) async {
    if (_dmVisibilityRelayBaseUrl != relayBaseUrl ||
        _dmVisibilityPubkey != myPk) {
      _unsubscribeDmVisibility?.call();
      _unsubscribeDmVisibility = null;
      _dmVisibilityRelayBaseUrl = relayBaseUrl;
      _dmVisibilityPubkey = myPk;
      // A different relay/identity owns entirely different snapshots; drop the
      // dedup key so the new scope's first snapshot is honored.
      _lastHandledDmVisibilityEventId = null;
    }
    if (_unsubscribeDmVisibility != null || myPk == null) return;

    try {
      final unsubscribe = await session.subscribe(
        NostrFilter(
          kinds: const [EventKind.dmVisibility],
          tags: {
            '#p': [myPk],
          },
          // Replay the latest snapshot so publication in the gap after the
          // history fetch still refreshes the channel list.
          limit: 1,
        ),
        (event) {
          if (ref.read(relayConfigProvider).baseUrl == relayBaseUrl &&
              ref.read(myPubkeyProvider)?.toLowerCase() == myPk) {
            _handleDmVisibilityEvent(event);
          }
        },
      );
      if (!fence.isCurrent ||
          subscriptionVersion != _subscriptionVersion ||
          ref.read(relaySessionProvider).status != SessionStatus.connected ||
          ref.read(relayConfigProvider).baseUrl != relayBaseUrl ||
          ref.read(myPubkeyProvider)?.toLowerCase() != myPk) {
        unsubscribe();
        return;
      }
      _unsubscribeDmVisibility = unsubscribe;
    } catch (error) {
      debugPrint(
        '[ChannelsNotifier] DM visibility subscription failed: $error',
      );
    }
  }

  void _handleDmVisibilityEvent(NostrEvent event) {
    if (event.kind != EventKind.dmVisibility) return;
    // Suppress a re-delivered identical snapshot (see `_lastHandledDmVisibilityEventId`).
    // The relay replays the latest snapshot on every resubscribe; only a new
    // snapshot id should drive a refresh.
    if (event.id == _lastHandledDmVisibilityEventId) return;
    _lastHandledDmVisibilityEventId = event.id;
    unawaited(refresh());
  }

  void _clearDmVisibilitySubscription() {
    _unsubscribeDmVisibility?.call();
    _unsubscribeDmVisibility = null;
    _dmVisibilityRelayBaseUrl = null;
    _dmVisibilityPubkey = null;
    _lastHandledDmVisibilityEventId = null;
  }

  Set<String> _mutedChannelIds() => {
    for (final entry in ref.read(channelMutesProvider).store.channels.entries)
      if (entry.value.muted) entry.key,
  };

  Set<String> _followedRootIds() =>
      ref.read(threadFollowsProvider).followedRootIds;
}

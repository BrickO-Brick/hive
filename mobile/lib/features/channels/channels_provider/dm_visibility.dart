part of '../channels_provider.dart';

mixin _DmVisibilitySubscription on AsyncNotifier<List<Channel>> {
  void Function()? _unsubscribeDmVisibility;
  String? _dmVisibilityRelayBaseUrl;
  String? _dmVisibilityPubkey;

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
    unawaited(refresh());
  }

  void _clearDmVisibilitySubscription() {
    _unsubscribeDmVisibility?.call();
    _unsubscribeDmVisibility = null;
    _dmVisibilityRelayBaseUrl = null;
    _dmVisibilityPubkey = null;
  }

  Set<String> _mutedChannelIds() => {
    for (final entry in ref.read(channelMutesProvider).store.channels.entries)
      if (entry.value.muted) entry.key,
  };

  Set<String> _followedRootIds() =>
      ref.read(threadFollowsProvider).followedRootIds;
}

part of '../channels_page.dart';

class _ChannelsBody extends StatelessWidget {
  final List<Channel>? channels;
  final AsyncValue<List<Channel>> channelsAsync;
  final bool showError;
  final SessionStatus sessionStatus;
  final bool showConnectionSkeleton;
  final String? currentPubkey;
  final double topSectionHeight;
  final bool usesPinnedGradient;
  final ScrollController scrollController;
  final Future<void> Function() onRefresh;
  final Future<void> Function(Channel channel) onSelectChannel;

  const _ChannelsBody({
    required this.channels,
    required this.channelsAsync,
    required this.showError,
    required this.sessionStatus,
    required this.showConnectionSkeleton,
    required this.currentPubkey,
    required this.topSectionHeight,
    required this.usesPinnedGradient,
    required this.scrollController,
    required this.onRefresh,
    required this.onSelectChannel,
  });

  @override
  Widget build(BuildContext context) {
    final barHeight = topSectionHeight;
    final loadedChannels = channels;
    final loading =
        showConnectionSkeleton || (loadedChannels == null && !showError);
    final content = showError && channelsAsync.hasError
        ? Padding(
            padding: EdgeInsets.only(top: barHeight),
            child: _ErrorView(error: channelsAsync.error!, onRetry: onRefresh),
          )
        : loadedChannels == null
        ? const SizedBox.shrink()
        : BeeRefreshIndicator(
            edgeOffset: barHeight,
            onRefresh: onRefresh,
            child: CustomScrollView(
              controller: scrollController,
              // The transparent gap shows the top section and must not absorb
              // taps meant for the community or profile controls beneath it.
              hitTestBehavior: HitTestBehavior.deferToChild,
              slivers: [
                SliverToBoxAdapter(child: SizedBox(height: barHeight)),
                if (usesPinnedGradient)
                  _SliverChannelsList(
                    channels: loadedChannels,
                    currentPubkey: currentPubkey,
                    onSelectChannel: onSelectChannel,
                  )
                else
                  DecoratedSliver(
                    decoration: BoxDecoration(
                      color: context.colors.surface,
                      borderRadius: const BorderRadius.vertical(
                        top: Radius.circular(Radii.dialog),
                      ),
                    ),
                    sliver: _SliverChannelsList(
                      channels: loadedChannels,
                      currentPubkey: currentPubkey,
                      onSelectChannel: onSelectChannel,
                    ),
                  ),
              ],
            ),
          );

    return SkeletonReveal(
      loading: loading,
      shimmerEnabled: sessionStatus != SessionStatus.disconnected,
      skeleton: _ChannelsSkeleton(
        channels: loadedChannels,
        topInset: barHeight,
        status: sessionStatus,
      ),
      content: content,
    );
  }
}

class _SliverChannelsList extends HookConsumerWidget {
  final List<Channel> channels;
  final String? currentPubkey;
  final Future<void> Function(Channel channel) onSelectChannel;

  const _SliverChannelsList({
    required this.channels,
    required this.currentPubkey,
    required this.onSelectChannel,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final readState = ref.watch(readStateProvider);
    final sectionsState = ref.watch(channelSectionsProvider);
    final mutesState = ref.watch(channelMutesProvider);
    final mutedChannelIds = {
      for (final entry in mutesState.store.channels.entries)
        if (entry.value.muted) entry.key,
    };
    final starsState = ref.watch(channelStarsProvider);
    final starredChannelIds = {
      for (final entry in starsState.store.channels.entries)
        if (entry.value.starred) entry.key,
    };
    final visibleChannels = channels
        .where((channel) => channel.isMember && !channel.isArchived)
        .toList();
    final streamChannels = visibleChannels
        .where((channel) => channel.isStream)
        .toList();
    final dmChannels = sortDmChannelsByDisplayLabel(
      visibleChannels.where((channel) => channel.isDm),
      currentPubkey: currentPubkey,
    );

    final starredExpanded = useState(true);
    final channelsExpanded = useState(true);
    final dmsExpanded = useState(true);
    final sortState = ref.watch(channelSortProvider);
    final initialSeedComplete = useState(false);
    final seededPubkey = useRef<String?>(null);
    final seedCompleteForPubkey =
        seededPubkey.value == readState.pubkey && initialSeedComplete.value;

    useEffect(() {
      if (!readState.isReady) {
        return null;
      }

      return deferReadStateUpdate(context, () {
        if (seededPubkey.value != readState.pubkey) {
          seededPubkey.value = readState.pubkey;
          initialSeedComplete.value = false;
        }

        if (initialSeedComplete.value) {
          return;
        }

        final notifier = ref.read(readStateProvider.notifier);
        for (final channel in visibleChannels) {
          if (readState.effectiveTimestamp(channel.id) != null) {
            continue;
          }

          final lastMessageAt = dateTimeToUnixSeconds(channel.lastMessageAt);
          if (lastMessageAt != null) {
            notifier.seedContextRead(channel.id, lastMessageAt);
          }
        }
        initialSeedComplete.value = true;
      });
    }, [readState.isReady, readState.pubkey, visibleChannels]);

    final unreadState = _computeUnreadChannelState(
      channels: visibleChannels,
      readState: readState,
      channelsNotifier: ref.read(channelsProvider.notifier),
    );
    final unreadChannelIds = {
      for (final channelId in unreadState.ids)
        if (seedCompleteForPubkey ||
            readState.effectiveTimestamp(channelId) != null)
          channelId,
    };
    // Build sorted user-defined sections and compute which stream channels
    // belong to each section. Channels not assigned to any valid section fall
    // through to the built-in "Channels" list.
    final userSections = sectionsState.store.sections.toList()
      ..sort((a, b) => a.order.compareTo(b.order));
    final sectionAssignments = sectionsState.store.assignments;
    final validSectionIds = {for (final s in userSections) s.id};
    final assignedChannelIds = {
      for (final entry in sectionAssignments.entries)
        if (validSectionIds.contains(entry.value)) entry.key,
    };
    // Starred is exclusive: a starred channel lives only in the Starred section,
    // not in its custom section or the default Channels list.
    final starredStreamChannels = sortChannelsForList(
      streamChannels.where((c) => starredChannelIds.contains(c.id)).toList(),
      sortState.sortModeFor('starred'),
    );
    final ungroupedStreamChannels = sortChannelsForList(
      streamChannels
          .where(
            (c) =>
                !assignedChannelIds.contains(c.id) &&
                !starredChannelIds.contains(c.id),
          )
          .toList(),
      sortState.sortModeFor('channels'),
    );
    // DMs default to the display-label alphabetical order (labels can differ
    // from channel names); Recent mode reorders by last message time.
    final sortedDmChannels =
        sortState.sortModeFor('dms') == ChannelSortMode.recent
        ? sortChannelsForList(dmChannels, ChannelSortMode.recent)
        : dmChannels;

    final liveSectionIds = [for (final s in userSections) s.id];
    void setSortMode(String groupKey, ChannelSortMode mode) {
      ref
          .read(channelSortProvider.notifier)
          .setSortModeFor(groupKey, mode, liveSectionIds: liveSectionIds);
    }

    final sectionExpandedStates = useState<Map<String, bool>>({});

    bool sectionExpanded(String sectionId) =>
        sectionExpandedStates.value[sectionId] ?? true;

    void toggleSection(String sectionId) {
      sectionExpandedStates.value = {
        ...sectionExpandedStates.value,
        sectionId: !sectionExpanded(sectionId),
      };
    }

    final children = <Widget>[];

    void addDivider() => children.add(const _SectionDivider());

    void addChannelRows(
      List<Channel> sectionChannels, {
      required bool expanded,
      String? sectionId,
      bool allowMarkRead = false,
    }) {
      if (!expanded) return;
      for (final channel in sectionChannels) {
        children.add(
          _ChannelTile(
            key: ValueKey('channel-tile-${channel.id}'),
            channel: channel,
            isUnread: unreadChannelIds.contains(channel.id),
            isMuted: mutedChannelIds.contains(channel.id),
            currentPubkey: currentPubkey,
            onTap: () => onSelectChannel(channel),
            onMarkRead: allowMarkRead
                ? () {
                    final ts = dateTimeToUnixSeconds(channel.lastMessageAt);
                    if (ts == null) return;
                    ref
                        .read(readStateProvider.notifier)
                        .markContextRead(
                          channel.id,
                          ts,
                          clearForcedMessages: true,
                        );
                    ref
                        .read(channelsProvider.notifier)
                        .clearObservedUnreadCoveredByRead(channel.id, ts);
                  }
                : null,
            sectionId: sectionId,
          ),
        );
      }
      children.add(const SizedBox(height: _kExpandedSectionTrailingPadding));
    }

    void addBuiltInSection({
      required String title,
      required IconData icon,
      required bool showTopDivider,
      required bool expanded,
      required VoidCallback onToggle,
      required List<Channel> sectionChannels,
      required String emptyLabel,
      required String sortKey,
    }) {
      if (showTopDivider) addDivider();
      children.add(
        _SectionHeader(
          label: title,
          icon: icon,
          expanded: expanded,
          onToggle: onToggle,
          sortMode: sortState.sortModeFor(sortKey),
          onSortModeChange: (mode) => setSortMode(sortKey, mode),
        ),
      );
      if (expanded && sectionChannels.isEmpty) {
        children.add(_EmptySectionLabel(label: emptyLabel));
        children.add(const SizedBox(height: _kExpandedSectionTrailingPadding));
      } else {
        addChannelRows(sectionChannels, expanded: expanded);
      }
    }

    if (visibleChannels.isEmpty) {
      children.add(const _EmptyState());
    } else {
      if (starredStreamChannels.isNotEmpty) {
        addBuiltInSection(
          title: 'Starred',
          icon: LucideIcons.star,
          showTopDivider: false,
          expanded: starredExpanded.value,
          onToggle: () => starredExpanded.value = !starredExpanded.value,
          sectionChannels: starredStreamChannels,
          emptyLabel: '',
          sortKey: 'starred',
        );
      }

      for (final section in userSections) {
        final sectionChannels = sortChannelsForList(
          streamChannels
              .where(
                (channel) =>
                    sectionAssignments[channel.id] == section.id &&
                    !starredChannelIds.contains(channel.id),
              )
              .toList(),
          sortState.sortModeFor(sectionSortGroupKey(section.id)),
        );
        final expanded = sectionExpanded(section.id);
        final isFirst = userSections.first.id == section.id;
        if (starredStreamChannels.isNotEmpty || !isFirst) addDivider();
        children.add(
          _CustomSectionHeader(
            section: section,
            expanded: expanded,
            isFirst: isFirst,
            isLast: userSections.last.id == section.id,
            onToggle: () => toggleSection(section.id),
            onRename: () async {
              final name = await showBuzzDialog<String>(
                context: context,
                builder: (_) => _SectionNameDialog(
                  title: 'Rename Section',
                  confirmLabel: 'Rename',
                  initialValue: section.name,
                ),
              );
              if (name != null && name.isNotEmpty) {
                ref
                    .read(channelSectionsProvider.notifier)
                    .renameSection(section.id, name);
              }
            },
            onDelete: () async {
              final confirmed = await showBuzzDialog<bool>(
                context: context,
                builder: (_) => AlertDialog(
                  title: Text('Delete "${section.name}"?'),
                  content: const Text(
                    'Channels in this section will move back to the main list.',
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('Cancel'),
                    ),
                    TextButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: Text(
                        'Delete',
                        style: TextStyle(color: context.colors.error),
                      ),
                    ),
                  ],
                ),
              );
              if (confirmed == true) {
                ref
                    .read(channelSectionsProvider.notifier)
                    .deleteSection(section.id);
              }
            },
            onMoveUp: () => ref
                .read(channelSectionsProvider.notifier)
                .moveSectionUp(section.id),
            onMoveDown: () => ref
                .read(channelSectionsProvider.notifier)
                .moveSectionDown(section.id),
            sortMode: sortState.sortModeFor(sectionSortGroupKey(section.id)),
            onSortModeChange: (mode) =>
                setSortMode(sectionSortGroupKey(section.id), mode),
          ),
        );
        addChannelRows(
          sectionChannels,
          expanded: expanded,
          sectionId: section.id,
          allowMarkRead: true,
        );
      }

      addBuiltInSection(
        title: 'Channels',
        icon: LucideIcons.hash,
        showTopDivider:
            starredStreamChannels.isNotEmpty || userSections.isNotEmpty,
        expanded: channelsExpanded.value,
        onToggle: () => channelsExpanded.value = !channelsExpanded.value,
        sectionChannels: ungroupedStreamChannels,
        emptyLabel: 'No stream channels yet',
        sortKey: 'channels',
      );
      addBuiltInSection(
        title: 'DMs',
        icon: LucideIcons.messagesSquare,
        showTopDivider: true,
        expanded: dmsExpanded.value,
        onToggle: () => dmsExpanded.value = !dmsExpanded.value,
        sectionChannels: sortedDmChannels,
        emptyLabel: 'No direct messages yet',
        sortKey: 'dms',
      );
    }

    return SliverPadding(
      padding: EdgeInsets.only(
        top: Grid.xxs,
        bottom: MediaQuery.paddingOf(context).bottom,
      ),
      sliver: SliverList.builder(
        itemCount: children.length,
        itemBuilder: (context, index) => children[index],
      ),
    );
  }
}

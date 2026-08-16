part of '../composer_agent_activity_indicator.dart';

class _AgentSegmentedControl extends StatelessWidget {
  static const _inset = Grid.xxs;
  static const _cornerRadius = Radii.dialog - _inset;

  final List<String> agents;
  final String selectedAgent;
  final String Function(String) nameFor;
  final ValueChanged<String> onSelectAgent;

  const _AgentSegmentedControl({
    required this.agents,
    required this.selectedAgent,
    required this.nameFor,
    required this.onSelectAgent,
  });

  @override
  Widget build(BuildContext context) {
    final isIos = defaultTargetPlatform == TargetPlatform.iOS;

    return SizedBox(
      height: Grid.xl,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: _inset,
          vertical: Grid.half + Grid.quarter,
        ),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final control = isIos
                ? ClipRSuperellipse(
                    key: const ValueKey('composer-agent-segmented-frame'),
                    borderRadius: BorderRadius.circular(_cornerRadius),
                    clipBehavior: Clip.antiAlias,
                    child: DecoratedBox(
                      decoration: ShapeDecoration(
                        color: context.colors.surface,
                        shape: RoundedSuperellipseBorder(
                          borderRadius: BorderRadius.circular(_cornerRadius),
                          side: BorderSide(
                            color: context.colors.outlineVariant,
                          ),
                        ),
                      ),
                      child: CupertinoSlidingSegmentedControl<String>(
                        key: const ValueKey(
                          'composer-agent-segmented-container',
                        ),
                        groupValue: selectedAgent,
                        thumbColor: context.colors.primary,
                        backgroundColor: Colors.transparent,
                        proportionalWidth: false,
                        children: {
                          for (final agent in agents)
                            agent: _IosAgentSegment(
                              pubkey: agent,
                              label: nameFor(agent),
                              selected: agent == selectedAgent,
                            ),
                        },
                        onValueChanged: (agent) {
                          if (agent == null || agent == selectedAgent) return;
                          onSelectAgent(agent);
                        },
                      ),
                    ),
                  )
                : Material(
                    key: const ValueKey('composer-agent-segmented-container'),
                    color: context.colors.surface,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(Radii.md),
                      side: BorderSide(color: context.colors.outlineVariant),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (var index = 0; index < agents.length; index++) ...[
                          if (index > 0)
                            ColoredBox(
                              color: context.colors.outlineVariant,
                              child: const SizedBox(width: 1),
                            ),
                          _AgentSegment(
                            pubkey: agents[index],
                            label: nameFor(agents[index]),
                            selected: agents[index] == selectedAgent,
                            onTap: () => onSelectAgent(agents[index]),
                          ),
                        ],
                      ],
                    ),
                  );

            return SingleChildScrollView(
              key: const ValueKey('composer-agent-activity-selector'),
              scrollDirection: Axis.horizontal,
              child: ConstrainedBox(
                constraints: BoxConstraints(minWidth: constraints.maxWidth),
                child: control,
              ),
            );
          },
        ),
      ),
    );
  }
}

class _IosAgentSegment extends StatelessWidget {
  final String pubkey;
  final String label;
  final bool selected;

  const _IosAgentSegment({
    required this.pubkey,
    required this.label,
    required this.selected,
  });

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      key: ValueKey('composer-agent-segment-$pubkey'),
      constraints: const BoxConstraints(minWidth: 96, minHeight: Grid.md),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Grid.xxs),
        child: Center(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: context.textTheme.labelMedium?.copyWith(
              color: selected
                  ? context.colors.onPrimary
                  : context.colors.onSurfaceVariant,
              fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
            ),
          ),
        ),
      ),
    );
  }
}

class _AgentSegment extends StatelessWidget {
  final String pubkey;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _AgentSegment({
    required this.pubkey,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: ExcludeSemantics(
        child: Material(
          key: ValueKey('composer-agent-segment-$pubkey'),
          color: selected ? context.colors.primary : Colors.transparent,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minWidth: 96,
                minHeight: Grid.md,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: Grid.xxs),
                child: Center(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.labelMedium?.copyWith(
                      color: selected
                          ? context.colors.onPrimary
                          : context.colors.onSurfaceVariant,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AgentActivityControl extends StatelessWidget {
  final List<WorkingAgentSignal> signals;
  final String? selectedAgent;
  final AgentTurnState? selectedTurn;
  final List<TranscriptItem> transcript;
  final Map<String, UserProfile> profiles;
  final String Function(String) nameFor;
  final VoidCallback onTap;
  final double horizontalInset;

  const _AgentActivityControl({
    required this.signals,
    required this.selectedAgent,
    required this.selectedTurn,
    required this.transcript,
    required this.profiles,
    required this.nameFor,
    required this.onTap,
    required this.horizontalInset,
  });

  @override
  Widget build(BuildContext context) {
    final pubkeys = signals.isNotEmpty
        ? [for (final signal in signals) signal.pubkey]
        : [?selectedAgent];
    final label = _agentActivityLabel(
      pubkeys: pubkeys,
      selectedTurn: selectedTurn,
      transcript: transcript,
      nameFor: nameFor,
      expanded: false,
    );

    return Padding(
      padding: const EdgeInsets.only(
        left: 0,
        right: 0,
        bottom: Grid.xxs,
      ).add(EdgeInsets.symmetric(horizontal: horizontalInset)),
      child: Semantics(
        button: true,
        toggled: false,
        label: label.semanticLabel,
        child: ExcludeSemantics(
          child: Material(
            color: context.colors.surfaceContainerHighest,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(Radii.dialog),
              side: BorderSide(color: Colors.black.withValues(alpha: 0.04)),
            ),
            child: InkWell(
              key: const ValueKey('composer-agent-activity-control'),
              onTap: onTap,
              borderRadius: BorderRadius.circular(Radii.dialog),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: Grid.xxs,
                    vertical: Grid.half,
                  ),
                  child: Row(
                    children: [
                      _AgentAvatarStack(pubkeys: pubkeys, profiles: profiles),
                      const SizedBox(width: Grid.xxs),
                      Expanded(
                        child: Text(
                          label.visibleLabel,
                          style: context.textTheme.labelSmall?.copyWith(
                            color: context.colors.onSurfaceVariant,
                            fontWeight: FontWeight.w600,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      Icon(
                        LucideIcons.chevronUp,
                        size: 16,
                        color: context.colors.onSurfaceVariant,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AgentStatusRow extends StatelessWidget {
  final List<WorkingAgentSignal> signals;
  final Map<String, UserProfile> profiles;
  final String Function(String) nameFor;
  final double horizontalInset;

  const _AgentStatusRow({
    required this.signals,
    required this.profiles,
    required this.nameFor,
    required this.horizontalInset,
  });

  @override
  Widget build(BuildContext context) {
    final pubkeys = [for (final signal in signals) signal.pubkey];
    final text = switch (signals.length) {
      1 => '${nameFor(signals.single.pubkey)} is working…',
      _ => '${signals.length} agents are working…',
    };
    return Padding(
      padding: const EdgeInsets.only(
        left: 0,
        right: 0,
        bottom: Grid.xxs,
      ).add(EdgeInsets.symmetric(horizontal: horizontalInset)),
      child: Container(
        key: const ValueKey('composer-agent-status-only'),
        width: double.infinity,
        constraints: const BoxConstraints(minHeight: 44),
        padding: const EdgeInsets.symmetric(horizontal: Grid.xxs),
        decoration: BoxDecoration(
          color: context.colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(Radii.dialog),
          border: Border.all(color: Colors.black.withValues(alpha: 0.04)),
        ),
        child: Row(
          children: [
            _AgentAvatarStack(pubkeys: pubkeys, profiles: profiles),
            const SizedBox(width: Grid.xxs),
            Expanded(
              child: Text(
                text,
                style: context.textTheme.labelSmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AgentAvatarStack extends StatelessWidget {
  final List<String> pubkeys;
  final Map<String, UserProfile> profiles;

  const _AgentAvatarStack({required this.pubkeys, required this.profiles});

  @override
  Widget build(BuildContext context) {
    final visible = pubkeys.take(3).toList();
    return SizedBox(
      width: 24.0 + math.max(0, visible.length - 1) * 14.0,
      height: 24,
      child: Stack(
        children: [
          for (var index = 0; index < visible.length; index++)
            Positioned(
              left: index * 14.0,
              child: SmallAvatar(
                pubkey: visible[index],
                userCache: profiles,
                size: 24,
              ),
            ),
        ],
      ),
    );
  }
}

enum _ActivityStatus { working, finished, error, waiting }

_ActivityStatus _activityStatus(AgentTurnState? turn, bool isFallbackWorking) {
  return switch (turn?.phase) {
    AgentTurnPhase.working => _ActivityStatus.working,
    AgentTurnPhase.finished => _ActivityStatus.finished,
    AgentTurnPhase.error => _ActivityStatus.error,
    null =>
      isFallbackWorking ? _ActivityStatus.working : _ActivityStatus.waiting,
  };
}

({String visibleLabel, String semanticLabel}) _agentActivityLabel({
  required List<String> pubkeys,
  required AgentTurnState? selectedTurn,
  required List<TranscriptItem> transcript,
  required String Function(String) nameFor,
  required bool expanded,
}) {
  final action = expanded ? 'Collapse live activity.' : 'Show live activity.';
  if (pubkeys.length > 1) {
    return (
      visibleLabel: '${pubkeys.length} agents are working…',
      semanticLabel: '${pubkeys.length} agents are working. $action',
    );
  }
  final name = pubkeys.isEmpty ? 'Agent' : nameFor(pubkeys.single);
  final status = _selectedActivityHeadline(selectedTurn, transcript);
  return (
    visibleLabel: '$name $status',
    semanticLabel: '$name $status. $action',
  );
}

String _selectedActivityHeadline(
  AgentTurnState? selectedTurn,
  List<TranscriptItem> transcript,
) => switch (selectedTurn?.phase) {
  AgentTurnPhase.finished => 'finished',
  AgentTurnPhase.error => 'stopped with an error',
  _ =>
    transcript.isNotEmpty ? _compactHeadline(transcript.last) : 'is working…',
};

String _compactHeadline(TranscriptItem item) => switch (item) {
  final ToolItem tool => _toolActivityLabel(tool),
  final ThoughtItem thought => thought.title.toLowerCase(),
  final MessageItem message =>
    message.role == 'assistant' ? 'is responding…' : 'is reading the prompt…',
  final LifecycleItem lifecycle => lifecycle.title.toLowerCase(),
  MetadataItem() => 'is working…',
};

String _toolActivityLabel(ToolItem tool) {
  final title = tool.title.trim().isEmpty ? tool.toolName : tool.title.trim();
  return switch (tool.status) {
    ToolStatus.completed => 'Finished $title',
    ToolStatus.failed => '$title failed',
    ToolStatus.pending => 'Queued $title',
    ToolStatus.executing => 'Running $title',
  };
}

String _oneLine(String value) => value.replaceAll(RegExp(r'\s+'), ' ').trim();

String _transcriptVersion(List<TranscriptItem> transcript) {
  if (transcript.isEmpty) return 'empty';
  final last = transcript.last;
  final contentLength = switch (last) {
    final MessageItem item => item.text.length,
    final ThoughtItem item => item.text.length,
    final LifecycleItem item => item.text.length,
    final MetadataItem item => item.sections.length,
    final ToolItem item => item.result.length + item.args.length,
  };
  return '${transcript.length}:${last.id}:$contentLength';
}

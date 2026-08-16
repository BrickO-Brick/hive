import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:buzz/features/channels/agent_activity/active_agent_turns.dart';
import 'package:buzz/features/channels/agent_activity/observer_models.dart';
import 'package:buzz/features/channels/agent_activity/observer_subscription.dart';
import 'package:buzz/features/channels/agent_activity/working_bots_provider.dart';
import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/features/channels/channel_typing_provider.dart';
import 'package:buzz/features/profile/user_cache_provider.dart';
import 'package:buzz/features/profile/user_profile.dart';
import 'package:buzz/shared/mentions/agent_identity_provider.dart';

const _channelId = 'channel-1';

void main() {
  test('prefers observer work and keeps human typing separate', () {
    final observerTurn = _turn('agent-a');
    final container = ProviderContainer(
      overrides: [
        currentPubkeyProvider.overrideWith((ref) => 'owner'),
        channelMembersProvider(
          _channelId,
        ).overrideWith((ref) async => const <ChannelMember>[]),
        channelTypingProvider(_channelId).overrideWith(
          () => _FakeTypingNotifier(const [
            TypingEntry(pubkey: 'agent-a', expiresAtMs: 9999999999999),
            TypingEntry(pubkey: 'agent-b', expiresAtMs: 9999999999999),
            TypingEntry(pubkey: 'human', expiresAtMs: 9999999999999),
          ]),
        ),
        agentMentionPubkeysProvider(
          _channelId,
        ).overrideWith((ref) => const {'agent-a', 'agent-b'}),
        agentOwnersProvider.overrideWithValue(
          const AsyncData({'agent-a': 'owner', 'agent-b': 'owner'}),
        ),
        userCacheProvider.overrideWith(_FakeUserCacheNotifier.new),
        observerRelayProvider.overrideWith(
          () => _FakeObserverRelayNotifier({
            'agent-a': [_observerFrame('agent-a')],
          }),
        ),
        activeAgentTurnsProvider.overrideWithValue([observerTurn]),
      ],
    );
    addTearDown(container.dispose);

    final state = container.read(
      composerActivityStateProvider((
        channelId: _channelId,
        threadHeadId: null,
      )),
    );

    expect(state.agents, hasLength(2));
    expect(state.agents[0].pubkey, 'agent-a');
    expect(state.agents[0].source, AgentWorkingSource.observer);
    expect(state.agents[0].canViewActivity, isTrue);
    expect(state.agents[1].source, AgentWorkingSource.typing);
    expect(state.agents[1].canViewActivity, isTrue);
    expect(state.humanTyping.single.pubkey, 'human');
  });

  test(
    'thread scope requires typing and does not surface observer-only work',
    () {
      final container = ProviderContainer(
        overrides: [
          currentPubkeyProvider.overrideWith((ref) => 'owner'),
          channelMembersProvider(
            _channelId,
          ).overrideWith((ref) async => const <ChannelMember>[]),
          channelTypingProvider(_channelId).overrideWith(
            () => _FakeTypingNotifier(const [
              TypingEntry(
                pubkey: 'agent-b',
                threadHeadId: 'thread-1',
                expiresAtMs: 9999999999999,
              ),
              TypingEntry(
                pubkey: 'human',
                threadHeadId: 'thread-1',
                expiresAtMs: 9999999999999,
              ),
            ]),
          ),
          agentMentionPubkeysProvider(
            _channelId,
          ).overrideWith((ref) => const {'agent-a', 'agent-b'}),
          agentOwnersProvider.overrideWithValue(
            const AsyncData({'agent-b': 'owner'}),
          ),
          userCacheProvider.overrideWith(_FakeUserCacheNotifier.new),
          observerRelayProvider.overrideWith(
            () => _FakeObserverRelayNotifier({
              'agent-a': [_observerFrame('agent-a')],
            }),
          ),
          activeAgentTurnsProvider.overrideWithValue([_turn('agent-a')]),
        ],
      );
      addTearDown(container.dispose);

      final state = container.read(
        composerActivityStateProvider((
          channelId: _channelId,
          threadHeadId: 'thread-1',
        )),
      );

      expect(state.agents.single.pubkey, 'agent-b');
      expect(state.agents.single.source, AgentWorkingSource.typing);
      expect(state.humanTyping.single.pubkey, 'human');
    },
  );
}

AgentTurnState _turn(String pubkey) => AgentTurnState(
  agentPubkey: pubkey,
  channelId: _channelId,
  turnId: 'turn-$pubkey',
  startedAt: DateTime.utc(2026, 8, 16, 12),
  lastActivityAt: DateTime.utc(2026, 8, 16, 12),
  livenessTimeout: const Duration(seconds: 30),
  phase: AgentTurnPhase.working,
);

ObserverFrame _observerFrame(String pubkey) => ObserverFrame(
  seq: 1,
  timestamp: DateTime.utc(2026, 8, 16, 12).toIso8601String(),
  kind: 'turn_started',
  channelId: _channelId,
  turnId: 'turn-$pubkey',
);

class _FakeTypingNotifier extends ChannelTypingNotifier {
  final List<TypingEntry> entries;

  _FakeTypingNotifier(this.entries) : super(_channelId);

  @override
  List<TypingEntry> build() => entries;
}

class _FakeUserCacheNotifier extends UserCacheNotifier {
  @override
  Map<String, UserProfile> build() => const {};

  @override
  void preload(List<String> pubkeys) {}
}

class _FakeObserverRelayNotifier extends ObserverRelayNotifier {
  final Map<String, List<ObserverFrame>> frames;

  _FakeObserverRelayNotifier(this.frames);

  @override
  ObserverRelayState build() => ObserverRelayState(
    connection: ObserverConnectionState.open,
    framesByAgent: frames,
  );
}

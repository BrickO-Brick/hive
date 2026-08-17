import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/features/channels/agent_activity/active_agent_turns.dart';
import 'package:buzz/features/channels/agent_activity/observer_models.dart';

void main() {
  test('tracks and refreshes a live turn using device receipt time', () {
    final turns = reduceAgentTurnStates({
      'AGENT-A': [
        _frame(
          seq: 1,
          second: 1,
          kind: 'turn_started',
          receivedSecond: 10,
          payload: {
            'triggeringEventIds': ['message-1'],
          },
        ),
        _frame(seq: 2, second: 11, kind: 'turn_liveness', receivedSecond: 20),
      ],
    }, now: DateTime.utc(2026, 8, 16, 12, 0, 25));

    expect(turns, hasLength(1));
    expect(turns.single.agentPubkey, 'agent-a');
    expect(turns.single.phase, AgentTurnPhase.working);
    expect(turns.single.triggeringEventId, 'message-1');
    expect(turns.single.lastActivityAt, DateTime.utc(2026, 8, 16, 12, 0, 20));
  });

  test('preserves explicit completion and error outcomes', () {
    final turns = reduceAgentTurnStates({
      'agent-a': [
        _frame(seq: 1, second: 1, kind: 'turn_started'),
        _frame(seq: 2, second: 2, kind: 'turn_completed'),
      ],
      'agent-b': [
        _frame(seq: 1, second: 1, kind: 'turn_started', turnId: 'turn-b'),
        _frame(
          seq: 2,
          second: 2,
          kind: 'turn_error',
          turnId: 'turn-b',
          payload: {'error': 'Tool permission denied'},
        ),
      ],
    }, now: DateTime.utc(2026, 8, 16, 12, 1));

    expect(turns, hasLength(2));
    expect(turns[0].phase, AgentTurnPhase.finished);
    expect(turns[1].phase, AgentTurnPhase.error);
    expect(turns[1].errorMessage, 'Tool permission denied');
  });

  test('keeps an error terminal when generic completion arrives later', () {
    final turns = reduceAgentTurnStates({
      'agent-a': [
        _frame(seq: 1, second: 1, kind: 'turn_started'),
        _frame(
          seq: 2,
          second: 2,
          kind: 'turn_error',
          payload: {'error': 'Agent timed out'},
        ),
        _frame(seq: 3, second: 3, kind: 'turn_completed'),
      ],
    }, now: DateTime.utc(2026, 8, 16, 12, 1));

    expect(turns, hasLength(1));
    expect(turns.single.phase, AgentTurnPhase.error);
    expect(turns.single.errorMessage, 'Agent timed out');
    expect(turns.single.terminalAt, DateTime.utc(2026, 8, 16, 12, 0, 2));
  });

  test('expires silence without claiming the turn finished', () {
    final turns = reduceAgentTurnStates({
      'agent-a': [_frame(seq: 1, second: 1, kind: 'turn_started')],
    }, now: DateTime.utc(2026, 8, 16, 12, 0, 32));

    expect(turns, isEmpty);
  });

  test('uses the advertised liveness interval to expire quiet turns', () {
    final frames = {
      'agent-a': [
        _frame(
          seq: 1,
          second: 1,
          kind: 'turn_started',
          payload: {'livenessIntervalSecs': 120},
        ),
      ],
    };

    final beforeTimeout = reduceAgentTurnStates(
      frames,
      now: DateTime.utc(2026, 8, 16, 12, 2, 30),
    );
    final afterTimeout = reduceAgentTurnStates(
      frames,
      now: DateTime.utc(2026, 8, 16, 12, 2, 32),
    );

    expect(beforeTimeout, hasLength(1));
    expect(beforeTimeout.single.livenessTimeout, const Duration(seconds: 150));
    expect(afterTimeout, isEmpty);
  });

  test('honors advertised liveness intervals longer than one day', () {
    final frames = {
      'agent-a': [
        _frame(
          seq: 1,
          second: 1,
          kind: 'turn_started',
          payload: {'livenessIntervalSecs': 48 * 60 * 60},
        ),
      ],
    };

    final beforeTimeout = reduceAgentTurnStates(
      frames,
      now: DateTime.utc(2026, 8, 18, 12, 0, 30),
    );
    final afterTimeout = reduceAgentTurnStates(
      frames,
      now: DateTime.utc(2026, 8, 18, 12, 0, 32),
    );

    expect(beforeTimeout, hasLength(1));
    expect(
      beforeTimeout.single.livenessTimeout,
      const Duration(hours: 48, seconds: 30),
    );
    expect(afterTimeout, isEmpty);
  });

  test('keeps liveness-disabled turns until the bounded crash backstop', () {
    final frames = {
      'agent-a': [
        _frame(
          seq: 1,
          second: 1,
          kind: 'turn_started',
          payload: {'livenessIntervalSecs': 0},
        ),
      ],
    };

    final longRunning = reduceAgentTurnStates(
      frames,
      now: DateTime.utc(2026, 8, 23, 12),
    );
    final pastBackstop = reduceAgentTurnStates(
      frames,
      now: DateTime.utc(2026, 8, 23, 12, 0, 32),
    );

    expect(longRunning, hasLength(1));
    expect(
      longRunning.single.livenessTimeout,
      const Duration(days: 7, seconds: 30),
    );
    expect(pastBackstop, isEmpty);
  });

  test('recovers a missed start and rejects stale post-terminal liveness', () {
    final turns = reduceAgentTurnStates({
      'agent-a': [
        _frame(
          seq: 1,
          second: 1,
          kind: 'turn_liveness',
          startedAt: DateTime.utc(2026, 8, 16, 11, 59).toIso8601String(),
        ),
        _frame(seq: 2, second: 2, kind: 'turn_completed'),
        _frame(
          seq: 0,
          second: 1,
          kind: 'turn_liveness',
          startedAt: DateTime.utc(2026, 8, 16, 11, 59).toIso8601String(),
        ),
      ],
    }, now: DateTime.utc(2026, 8, 16, 12, 0, 20));

    expect(turns, hasLength(1));
    expect(turns.single.phase, AgentTurnPhase.finished);
    expect(turns.single.startedAt, DateTime.utc(2026, 8, 16, 11, 59));
  });

  test('terminal without a turn id updates the latest turn in its channel', () {
    final turns = reduceAgentTurnStates({
      'agent-a': [
        _frame(seq: 1, second: 1, kind: 'turn_started'),
        _frame(
          seq: 2,
          second: 2,
          kind: 'agent_panic',
          turnId: null,
          payload: {'error': 'Process exited'},
        ),
      ],
    }, now: DateTime.utc(2026, 8, 16, 12, 0, 20));

    expect(turns.single.phase, AgentTurnPhase.error);
    expect(turns.single.errorMessage, 'Process exited');
  });
}

ObserverFrame _frame({
  required int seq,
  required int second,
  required String kind,
  String? turnId = 'turn-1',
  String channelId = 'channel-1',
  int? receivedSecond,
  String? startedAt,
  dynamic payload = const <String, dynamic>{},
}) {
  return ObserverFrame(
    seq: seq,
    timestamp: DateTime.utc(2026, 8, 16, 12, 0, second).toIso8601String(),
    kind: kind,
    channelId: channelId,
    turnId: turnId,
    startedAt: startedAt,
    receivedAt: receivedSecond == null
        ? null
        : DateTime.utc(2026, 8, 16, 12, 0, receivedSecond),
    payload: payload,
  );
}

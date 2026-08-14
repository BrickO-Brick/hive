import 'package:flutter/foundation.dart';

enum SessionStatus { disconnected, connecting, connected, reconnecting }

@immutable
class SessionState {
  final SessionStatus status;
  final int reconnectAttempt;

  const SessionState({required this.status, this.reconnectAttempt = 0});
}

import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:just_audio/just_audio.dart' as audio;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

const voiceNoteMaxDuration = Duration(minutes: 5);
const voiceNotePlaybackRates = <double>[1, 1.5, 2, 0.5];

double nextVoiceNotePlaybackRate(double current) {
  final index = voiceNotePlaybackRates.indexOf(current);
  return voiceNotePlaybackRates[(index + 1) % voiceNotePlaybackRates.length];
}

String formatVoiceNotePlaybackRate(double rate) =>
    '${rate == 0.5 ? '.5' : rate.toStringAsFixed(rate % 1 == 0 ? 0 : 1)}×';

@immutable
class VoiceNoteRecording {
  const VoiceNoteRecording({
    required this.file,
    required this.duration,
    required this.waveform,
  });

  final XFile file;
  final Duration duration;
  final List<double> waveform;
}

abstract interface class VoiceNoteRecorder {
  Stream<double> get levels;

  Future<void> start();

  Future<VoiceNoteRecording> stop();

  Future<void> cancel();

  Future<void> dispose();
}

final voiceNoteRecorderFactoryProvider = Provider<VoiceNoteRecorder Function()>(
  (ref) => DeviceVoiceNoteRecorder.new,
);

class DeviceVoiceNoteRecorder implements VoiceNoteRecorder {
  final AudioRecorder _recorder = AudioRecorder();
  final StreamController<double> _levels = StreamController.broadcast();
  final List<double> _samples = [];
  StreamSubscription<Amplitude>? _amplitudeSubscription;
  DateTime? _startedAt;
  String? _path;
  bool _finished = false;

  @override
  Stream<double> get levels => _levels.stream;

  @override
  Future<void> start() async {
    if (!await _recorder.hasPermission()) {
      throw StateError('Microphone access is required to record a voice note.');
    }
    final directory = await getTemporaryDirectory();
    final path =
        '${directory.path}${Platform.pathSeparator}'
        'voice-note-${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        bitRate: 96000,
        sampleRate: 44100,
        numChannels: 1,
        autoGain: true,
        echoCancel: true,
        noiseSuppress: true,
      ),
      path: path,
    );
    _path = path;
    _startedAt = DateTime.now();
    _amplitudeSubscription = _recorder
        .onAmplitudeChanged(const Duration(milliseconds: 80))
        .listen((amplitude) {
          final normalized =
              (math
                          .pow(10, amplitude.current.clamp(-60.0, 0.0) / 20)
                          .toDouble() *
                      4)
                  .clamp(0.04, 1.0);
          _samples.add(normalized);
          if (!_levels.isClosed) _levels.add(normalized);
        });
  }

  @override
  Future<VoiceNoteRecording> stop() async {
    if (_finished) throw StateError('Voice note recording already ended.');
    _finished = true;
    await _amplitudeSubscription?.cancel();
    final recordedPath = await _recorder.stop() ?? _path;
    if (recordedPath == null || recordedPath.isEmpty) {
      throw StateError('Buzz could not finish the voice note.');
    }
    final startedAt = _startedAt;
    final duration = startedAt == null
        ? Duration.zero
        : DateTime.now().difference(startedAt);
    return VoiceNoteRecording(
      file: XFile(recordedPath, mimeType: 'audio/mp4'),
      duration: duration,
      waveform: List.unmodifiable(_samples),
    );
  }

  @override
  Future<void> cancel() async {
    if (_finished) return;
    _finished = true;
    await _amplitudeSubscription?.cancel();
    await _recorder.cancel();
  }

  @override
  Future<void> dispose() async {
    await _amplitudeSubscription?.cancel();
    await _recorder.dispose();
    await _levels.close();
  }
}

@immutable
class VoiceNotePlaybackState {
  const VoiceNotePlaybackState({
    this.position = Duration.zero,
    this.duration = Duration.zero,
    this.isPlaying = false,
    this.isLoading = false,
    this.hasError = false,
  });

  final Duration position;
  final Duration duration;
  final bool isPlaying;
  final bool isLoading;
  final bool hasError;

  VoiceNotePlaybackState copyWith({
    Duration? position,
    Duration? duration,
    bool? isPlaying,
    bool? isLoading,
    bool? hasError,
  }) => VoiceNotePlaybackState(
    position: position ?? this.position,
    duration: duration ?? this.duration,
    isPlaying: isPlaying ?? this.isPlaying,
    isLoading: isLoading ?? this.isLoading,
    hasError: hasError ?? this.hasError,
  );
}

abstract class VoiceNotePlayerController extends ChangeNotifier {
  VoiceNotePlaybackState get state;

  Future<void> loadLocal(String path, {required Duration fallbackDuration});

  Future<void> loadRemote(
    String url, {
    required Map<String, String> headers,
    required Duration fallbackDuration,
  });

  Future<void> toggle();

  Future<void> seek(Duration position);

  Future<void> setSpeed(double speed);
}

final voiceNotePlayerFactoryProvider =
    Provider<VoiceNotePlayerController Function()>(
      (ref) => DeviceVoiceNotePlayerController.new,
    );

class DeviceVoiceNotePlayerController extends VoiceNotePlayerController {
  final audio.AudioPlayer _player = audio.AudioPlayer(
    useProxyForRequestHeaders: false,
  );
  final List<StreamSubscription<Object?>> _subscriptions = [];
  VoiceNotePlaybackState _state = const VoiceNotePlaybackState();
  bool _disposed = false;

  DeviceVoiceNotePlayerController() {
    _subscriptions.add(
      _player.positionStream.listen((position) {
        _update(_state.copyWith(position: position));
      }),
    );
    _subscriptions.add(
      _player.durationStream.listen((duration) {
        if (duration != null) _update(_state.copyWith(duration: duration));
      }),
    );
    _subscriptions.add(
      _player.playerStateStream.listen((playerState) {
        if (playerState.processingState == audio.ProcessingState.completed) {
          _update(
            _state.copyWith(
              position: Duration.zero,
              isPlaying: false,
              isLoading: false,
            ),
          );
          unawaited(_stopAndRewindCompletedPlayback());
          return;
        }
        _update(
          _state.copyWith(
            isPlaying: playerState.playing,
            isLoading:
                playerState.processingState == audio.ProcessingState.loading ||
                playerState.processingState == audio.ProcessingState.buffering,
          ),
        );
      }),
    );
  }

  Future<void> _stopAndRewindCompletedPlayback() async {
    await _player.pause();
    await _player.seek(Duration.zero);
  }

  @override
  VoiceNotePlaybackState get state => _state;

  @override
  Future<void> loadLocal(String path, {required Duration fallbackDuration}) =>
      _load(
        () => _player.setFilePath(path),
        fallbackDuration: fallbackDuration,
      );

  @override
  Future<void> loadRemote(
    String url, {
    required Map<String, String> headers,
    required Duration fallbackDuration,
  }) => _load(
    () => _player.setUrl(url, headers: headers),
    fallbackDuration: fallbackDuration,
  );

  Future<void> _load(
    Future<Duration?> Function() load, {
    required Duration fallbackDuration,
  }) async {
    _update(
      VoiceNotePlaybackState(duration: fallbackDuration, isLoading: true),
    );
    try {
      final duration = await load();
      _update(
        _state.copyWith(
          duration: duration ?? fallbackDuration,
          isLoading: false,
          hasError: false,
        ),
      );
    } catch (_) {
      _update(_state.copyWith(isLoading: false, hasError: true));
    }
  }

  @override
  Future<void> toggle() async {
    if (_state.hasError || _state.isLoading) return;
    if (_player.playing) {
      await _player.pause();
    } else {
      await _player.play();
    }
  }

  @override
  Future<void> seek(Duration position) => _player.seek(position);

  @override
  Future<void> setSpeed(double speed) => _player.setSpeed(speed);

  void _update(VoiceNotePlaybackState next) {
    if (_disposed) return;
    _state = next;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    unawaited(_player.dispose());
    super.dispose();
  }
}

String formatVoiceNoteDuration(Duration duration) {
  final totalSeconds = math.max(0, duration.inSeconds);
  final minutes = totalSeconds ~/ 60;
  final seconds = totalSeconds % 60;
  return '$minutes:${seconds.toString().padLeft(2, '0')}';
}

List<double> normalizeVoiceNoteWaveform(
  List<double> samples, {
  int barCount = 36,
}) {
  if (barCount <= 0) return const [];
  if (samples.isEmpty) return List.filled(barCount, 0.12);
  return List.generate(barCount, (index) {
    final start = (index * samples.length / barCount).floor();
    final end = math.max(
      start + 1,
      ((index + 1) * samples.length / barCount).floor(),
    );
    var peak = 0.0;
    for (
      var sampleIndex = start;
      sampleIndex < end && sampleIndex < samples.length;
      sampleIndex++
    ) {
      peak = math.max(peak, samples[sampleIndex]);
    }
    return peak.clamp(0.08, 1.0);
  });
}

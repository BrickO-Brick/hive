import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:nostr/nostr.dart' as nostr;

import '../relay/nostr_models.dart';
import 'push_capability.dart';

const _pushPresentationChannel = MethodChannel('buzz/push');
const _maximumAvatarSourceBytes = 512 * 1024;
const _maximumAvatarPNGBytes = 64 * 1024;
Future<void> _avatarEncodeTail = Future.value();

/// The latest best-effort App Group presentation-cache failure.
final pushPresentationCacheError = ValueNotifier<String?>(null);

/// Revalidates a relay event before it crosses into the native cache writer.
bool isVerifiedPushPresentationEvent(NostrEvent event) {
  try {
    nostr.Event(
      event.id,
      event.pubkey,
      event.createdAt,
      event.kind,
      event.tags,
      event.content,
      event.sig,
    );
    return true;
  } catch (_) {
    return false;
  }
}

/// Exports raw verified kind-0 events. Native code verifies them again before storage.
Future<void> cacheBuzzPushProfileEvents(
  String communityID,
  Iterable<NostrEvent> events,
) async {
  if (!buzzPushCapabilityEnabled ||
      defaultTargetPlatform != TargetPlatform.iOS ||
      communityID.isEmpty) {
    return;
  }
  final verified = events
      .where(
        (event) => event.kind == 0 && isVerifiedPushPresentationEvent(event),
      )
      .toList();
  if (verified.isEmpty) return;
  await _invokeBestEffort('cachePresentationProfiles', {
    'communityId': communityID,
    'events': [for (final event in verified) event.toJson()],
  });
}

/// Exports raw verified kind-39000 events for relay-authority validation and storage.
Future<void> cacheBuzzPushChannelEvents(
  String communityID,
  Iterable<NostrEvent> events,
) async {
  if (!buzzPushCapabilityEnabled ||
      defaultTargetPlatform != TargetPlatform.iOS ||
      communityID.isEmpty) {
    return;
  }
  final verified = events
      .where(
        (event) =>
            event.kind == 39000 && isVerifiedPushPresentationEvent(event),
      )
      .toList();
  if (verified.isEmpty) return;
  await _invokeBestEffort('cachePresentationChannels', {
    'communityId': communityID,
    'events': [for (final event in verified) event.toJson()],
  });
}

/// Reuses bytes already fetched for a visible foreground avatar.
///
/// This never starts network I/O. Oversized, malformed, or unsupported images
/// are ignored, and notification delivery remains independent of the cache.
Future<void> cacheBuzzPushAvatarFromLoadedBytes(
  String communityID,
  String sourceURL,
  Uint8List sourceBytes,
) async {
  if (!buzzPushCapabilityEnabled ||
      defaultTargetPlatform != TargetPlatform.iOS ||
      communityID.isEmpty ||
      sourceBytes.isEmpty ||
      sourceBytes.length > _maximumAvatarSourceBytes ||
      !_isRemoteImageURL(sourceURL)) {
    return;
  }
  final previous = _avatarEncodeTail;
  final release = Completer<void>();
  _avatarEncodeTail = release.future;
  await previous;
  try {
    final png = await _boundedAvatarPNG(sourceBytes);
    if (png == null) return;
    await _invokeBestEffort('cachePresentationAvatar', {
      'communityId': communityID,
      'sourceUrl': sourceURL,
      'png': png,
    });
  } finally {
    release.complete();
  }
}

Future<void> _invokeBestEffort(
  String method,
  Map<String, Object> arguments,
) async {
  try {
    await _pushPresentationChannel.invokeMethod<void>(method, arguments);
    pushPresentationCacheError.value = null;
  } on MissingPluginException {
    // Push-free builds and non-Runner embeddings intentionally omit the bridge.
  } catch (error, stackTrace) {
    pushPresentationCacheError.value = error.toString();
    debugPrint('Push presentation cache update failed: $error');
    debugPrintStack(stackTrace: stackTrace);
  }
}

bool _isRemoteImageURL(String value) {
  final uri = Uri.tryParse(value.trim());
  return uri != null &&
      (uri.scheme == 'http' || uri.scheme == 'https') &&
      uri.host.isNotEmpty &&
      uri.userInfo.isEmpty;
}

Future<Uint8List?> _boundedAvatarPNG(Uint8List sourceBytes) async {
  for (final size in const [128, 96, 64, 48]) {
    ui.Codec? codec;
    ui.Image? image;
    try {
      codec = await ui.instantiateImageCodec(
        sourceBytes,
        targetWidth: size,
        targetHeight: size,
        allowUpscaling: false,
      );
      final frame = await codec.getNextFrame();
      image = frame.image;
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) continue;
      final png = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      if (png.isNotEmpty && png.length <= _maximumAvatarPNGBytes) return png;
    } catch (_) {
      return null;
    } finally {
      image?.dispose();
      codec?.dispose();
    }
  }
  return null;
}

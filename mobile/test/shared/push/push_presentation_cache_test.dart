import 'package:buzz/shared/push/push_presentation_cache.dart';
import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;

void main() {
  const secretKey =
      '0000000000000000000000000000000000000000000000000000000000000001';

  test('accepts a valid signed profile event', () {
    final signed = nostr.Event.from(
      kind: 0,
      content: '{"display_name":"Alice"}',
      secretKey: secretKey,
      createdAt: 1700000000,
    );

    expect(
      isVerifiedPushPresentationEvent(NostrEvent.fromJson(signed.toMap())),
      isTrue,
    );
  });

  test('accepts opaque channel IDs in a valid signed metadata event', () {
    final signed = nostr.Event.from(
      kind: 39000,
      content: '',
      tags: const [
        ['d', 'channel/general:v5'],
        ['name', 'General'],
      ],
      secretKey: secretKey,
      createdAt: 1700000000,
    );

    expect(
      isVerifiedPushPresentationEvent(NostrEvent.fromJson(signed.toMap())),
      isTrue,
    );
  });

  test('rejects changed content and malformed signatures', () {
    final signed = nostr.Event.from(
      kind: 0,
      content: '{"name":"Alice"}',
      secretKey: secretKey,
      createdAt: 1700000000,
    );
    final event = NostrEvent.fromJson(signed.toMap());

    expect(
      isVerifiedPushPresentationEvent(
        NostrEvent(
          id: event.id,
          pubkey: event.pubkey,
          createdAt: event.createdAt,
          kind: event.kind,
          tags: event.tags,
          content: '{"name":"Mallory"}',
          sig: event.sig,
        ),
      ),
      isFalse,
    );
    expect(
      isVerifiedPushPresentationEvent(
        NostrEvent(
          id: event.id,
          pubkey: event.pubkey,
          createdAt: event.createdAt,
          kind: event.kind,
          tags: event.tags,
          content: event.content,
          sig: '00',
        ),
      ),
      isFalse,
    );
  });
}

import 'package:buzz/shared/push/dev_push_lease.dart';
import 'package:buzz/shared/push/push_relay_capability_provider.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('valid capability permits notification authorization', () async {
    var requests = 0;

    final granted = await requestBuzzPushAuthorizationIfCapable(
      _descriptor,
      requestAuthorization: () async {
        requests += 1;
        return true;
      },
    );

    expect(granted, isTrue);
    expect(requests, 1);
  });

  test('missing or invalid capability cannot start authorization', () async {
    var requests = 0;

    final granted = await requestBuzzPushAuthorizationIfCapable(
      null,
      requestAuthorization: () async {
        requests += 1;
        return true;
      },
    );

    expect(granted, isFalse);
    expect(requests, 0);
  });

  for (final failure in <Object>[
    const FormatException('malformed descriptor'),
    StateError('relay unreachable'),
  ]) {
    test('$failure keeps capability inactive without authorization', () async {
      final descriptor = await discoverBuzzPushRelayCapability(
        'https://relay.example',
        fetchDescriptor: (_) async => throw failure,
      );
      var requests = 0;

      final granted = await requestBuzzPushAuthorizationIfCapable(
        descriptor,
        requestAuthorization: () async {
          requests += 1;
          return true;
        },
      );

      expect(descriptor, isNull);
      expect(granted, isFalse);
      expect(requests, 0);
    });
  }
}

const _descriptor = BuzzPushLeaseDescriptor(
  origin: 'wss://relay.example',
  executorKeyId: 'relay-v1',
  executorPubkey:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  transport: 'apns',
  maxLeaseTtlSeconds: 3600,
  maxContentLength: 4096,
  maxPlaintextLength: 4096,
  maxEndpointLength: 2048,
  maxStringLength: 512,
);

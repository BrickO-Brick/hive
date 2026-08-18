# Buzz Mobile

Flutter mobile client for Buzz.

## Setup

```bash
cd mobile
flutter pub get
```

## Run

```bash
# From repo root (applies a worktree-isolated debug identity and starts/reuses Simulator):
just mobile-dev

# Direct (uses the app's configured community; apply worktree overrides first):
cd mobile && flutter run
```

### Worktree-aware debug identity

Debug builds produced from a git worktree get a unique app identifier keyed
to the **worktree directory name**
(`xyz.block.buzz.dogfood.mobile.<slug>` on iOS,
`xyz.block.buzz.mobile.<slug>` on Android) plus a display-only branch label
in the app name (`Buzz (my-branch)`, or a short SHA when the worktree is
detached). Because the identifier follows the directory rather than the
branch, one worktree keeps exactly one installed app — and its login state —
across branch switches, and builds from multiple worktrees install side by
side, mirroring the desktop dev experience. Release and profile builds
always keep the production identity and name.

`just mobile-dev` and `just mobile-build-android` apply this automatically by
running `scripts/mobile-worktree-overrides.sh`, which writes two gitignored
files:

- `mobile/ios/Flutter/WorktreeOverrides.xcconfig` (included by Debug builds
  only; a developer's `AppOverrides.xcconfig` is included after it, so
  app-specific overrides like a personal `BUNDLE_IDENTIFIER` for device
  signing always win)
- `mobile/android/worktree.properties` (read by the debug build type only)

Android developers can keep a stable local test identity that takes precedence
over the generated worktree values by creating the gitignored
`mobile/android/AppOverrides.properties`:

```properties
appName=Buzz Pairing
applicationIdSuffix=.device_pairing_e2e1
```

These values are consumed by the debug build type only. The standard
`just mobile-build-android` command can still be used; regenerating
`worktree.properties` does not overwrite `AppOverrides.properties`. Release
and profile builds keep the production `Buzz` name and application ID.

For direct Xcode / Android Studio / `flutter run` development, run
`./scripts/mobile-worktree-overrides.sh` from the repo root once per branch
switch to refresh the display label (the install identity never changes);
the persisted files are then picked up by any subsequent build. In the main
checkout the script is a no-op that removes stale override files, restoring
the plain `Buzz` identity.

To remove leftover worktree-suffixed installs from booted iOS simulators and
connected Android emulators, run `just mobile-clean` (add `--dry-run` via
`./scripts/mobile-worktree-clean.sh --dry-run` to preview). Production
installs are never touched.

### Internal iOS push capability

iOS push is a compile/build capability and defaults off. A normal Debug,
Profile, Release, or App Store build excludes the native push bridge sources,
uses push-free Runner entitlements, and neither builds nor embeds the
Notification Service Extension. Dart also compiles out permission requests,
APNs registration, gateway enrollment/delegation, and relay lease behavior.

For an authorized internal dogfood build only, create the gitignored
`mobile/ios/Flutter/AppOverrides.xcconfig` with this single include:

```xcconfig
#include "PushEnabled.xcconfig"
```

The tracked overlay selects `xyz.block.buzz.dogfood.mobile`, production App
Attest/APNs entitlements, the internal development team, the push-capable
Runner entitlements, the native bridge, and the extension. CI may equivalently
inject that same include into its ephemeral `AppOverrides.xcconfig`; it must not
edit a tracked base configuration. Relay rollout is independent and remains off
unless its deployment sets `BUZZ_PUSH_ENABLED=true`. See
`docs/push-gateway-deployment.md` for the canonical gateway profile contract,
manual physical-device proof, measurements, and rollback procedure.

For local physical-device development, enable the same capability while
overriding the dogfood identity back to the normal mobile development identity
and sandbox environments:

```xcconfig
#include "PushEnabled.xcconfig"
BUNDLE_IDENTIFIER = xyz.block.buzz.mobile
BUZZ_DEVELOPMENT_TEAM = EYF346PHUG
BUZZ_IOS_PUSH_ENVIRONMENT = development
BUZZ_APP_ATTEST_ENVIRONMENT = development
```

This exercises the client, extension, relay, and gateway integration without
requiring a dogfood development signing identity. It uses the canonical
gateway's server-owned App Store profile configured for sandbox in the local
development gateway; it does not validate the internally distributed dogfood
artifact or enable the App Store profile in production. Validate dogfood APNs
end to end by cutting an internal release, waiting for it to reach Mobile
Releases/Comp Portal, and installing that signed artifact on a physical device.

## Checks

```bash
dart format --output=none --set-exit-if-changed .
flutter analyze
flutter test
```

Or from the repo root: `just mobile-check` and `just mobile-test`.

## Android release signing

Android release builds fail unless all upload-key inputs are supplied through the
environment:

- `BUZZ_ANDROID_UPLOAD_KEYSTORE_PATH`: path to a CI-vended keystore file
- `BUZZ_ANDROID_UPLOAD_KEYSTORE_PASSWORD`
- `BUZZ_ANDROID_UPLOAD_KEY_ALIAS`
- `BUZZ_ANDROID_UPLOAD_KEY_PASSWORD`

The keystore path must be absolute, and the keystore must remain outside the
repository. Development and debug builds do not require these variables.

Release pipelines that sign through the central APK Signer service instead of
a local upload keystore must set `BUZZ_ANDROID_RELEASE_SIGNING=external`. That
mode produces an unsigned release bundle and refuses to run if any
`BUZZ_ANDROID_UPLOAD_*` value is also set.

## Architecture

```
lib/
├── main.dart              # Entry point, Riverpod bootstrap
├── app.dart               # MaterialApp with theme
├── shared/
│   └── theme/             # Catppuccin light/dark, spacing tokens, extensions
└── features/
    └── home/              # Placeholder home surface
```

- **State management:** Riverpod + Hooks (`HookConsumerWidget`)
- **Theme:** Catppuccin Latte (light) / Macchiato (dark) — matches desktop
- **Spacing:** `Grid` tokens for consistent spacing
- **Linting:** `flutter_lints` + `riverpod_lint` via `custom_lint`
- **Feature isolation:** No cross-feature imports except `shared/`

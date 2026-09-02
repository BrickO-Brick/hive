# Hive onboarding design QA

- Source visual truth: `/var/folders/rm/th0xrtts6zn3ds9hn8y11hy40000gn/T/codex-clipboard-005697c3-0f55-4ad4-b102-14d2e8f7f06e.png`
- Brick robot-family reference: `/var/folders/rm/th0xrtts6zn3ds9hn8y11hy40000gn/T/codex-clipboard-793d97a8-c214-44ac-98b1-1e6d62b4b546.png`
- Authoritative BrickO character sheet: `/var/folders/rm/th0xrtts6zn3ds9hn8y11hy40000gn/T/codex-clipboard-707a11ca-b3f2-4a7c-a030-45028b32e37b.jpg`
- Implementation screenshot: `/Users/bricko/Work/Hive/desktop/test-results/onboarding-docked-cta/01b-enter-key.png`
- Branded landing screenshot: `/Users/bricko/Work/Hive/desktop/test-results/onboarding-docked-cta/01-landing.png`
- State: machine onboarding, existing-identity private-key entry, empty input, light appearance
- Viewport: 1680 × 1050 CSS px
- Density normalization: source is 3360 × 2100 px at Retina 2× (1680 × 1050 CSS equivalent); implementation is 1680 × 1050 px at 1×. Both were displayed at the same CSS size in the side-by-side comparison.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: Inter hierarchy, title weight, body measure, monospaced placeholder, and link emphasis preserve the reference. The Brick wordmark is supplied by the official vector asset rather than recreated as text.
- Spacing and layout rhythm: title, helper copy, textured key field, progress indicator, and docked Back/Next actions retain the source proportions at the normalized viewport. The first 1280 × 800 capture was not used for fidelity judgment because it made the fixed-width key field appear proportionally larger.
- Colors and visual tokens: chartreuse was intentionally replaced by Brick coral (`#ff6f52`), blush (`#ffb5a4`), and warm ivory (`#fff1ec`) while preserving the reference's vertical light transition, dot texture, dark ink, and disabled-action contrast.
- Image quality and asset fidelity: the top-left mark uses the repository's official `brick-logo.svg` on a compact white plate. The authoritative Operations Bot character sheet drives both the full-body onboarding hero and the simplified BrickO master icon, which remains legible at 128 px and 32 px. The baked nine-slice textured key field is retained; no placeholder was introduced.
- Copy and content: the sign-in, backup, and phone-recovery copy now consistently names Hive on this flow. Security behavior and recovery affordances are unchanged.

## Full-view comparison evidence

The source and normalized implementation were compared at the same CSS dimensions. Overall composition, card width, heading position, progress placement, and footer actions align. The dominant coral palette and official Brick logo are intentional requested changes; the product name remains Hive in the onboarding copy.

## Focused region comparison evidence

The header and key-entry region were inspected at full source-equivalent size. The coral Brick symbol and black BRICK wordmark are crisp and legible against their white plate, the title and helper copy remain centered, and the fuzzy key field preserves its original texture, crop, and placeholder alignment. No additional crop was required because all critical controls and copy were readable in the normalized full view.

## Comparison history

1. Initial implementation capture at 1280 × 800 passed interaction and responsive checks, but was excluded from fidelity scoring because the source was a 1680 × 1050 CSS-equivalent Retina capture.
2. Re-captured at 1680 × 1050 with the first Hive honey direction; layout fidelity passed, but the brand color and top-left mark were revised after user feedback.
3. Re-captured with the official Brick logo and coral–blush–ivory palette. The final comparison found no P0/P1/P2 mismatch.
4. An intermediate icon used the wrong hooded character from the first robot-family artwork. It was rejected after the authoritative BrickO reference arrived and is no longer present in the app.
5. Corrected BrickO identity from the hooded robot to the authoritative monitor-headed Operations Bot. Replaced the native/web icon, desktop hero, web hero, and every BrickO avatar with assets derived from the supplied character sheet.
6. Reframed the hero from report monitoring to pair-programming. The final hero uses the 12 supplied team references as recognizable cartoon identities inside one cohesive coding scene; no photo/avatar stack remains.
7. Added BrickO companion states tied to the real chat lifecycle: idle, thinking while the agent is typing or a reply is pending, and three deterministic completion variants (sparkle, check, and code). Reduced-motion preferences disable the movement.
8. Integrated all four bots into the same team scene: BrickO pair-programs at the center, BrickA handles reminders and automation pokes, BrickI carries client complaint signals, and BrickR presents an intentionally theatrical low-signal finding.

## Verification

- `pnpm check:px-text` — passed.
- `pnpm typecheck` — passed.
- `pnpm build:e2e` — passed.
- `pnpm exec playwright test tests/e2e/onboarding-docked-cta-screenshots.spec.ts:18 --project=smoke` — 1 focused screenshot-flow test passed.
- Full desktop onboarding screenshot spec — 4 tests passed, including the short-window interaction regression.
- Web `pnpm typecheck` and `pnpm build` — passed.
- `pnpm exec playwright test tests/e2e/smoke.spec.ts -g "Hive shows BrickO realtime activity" --project=smoke` — passed, including the production-seam thinking/celebration assertions.
- Tauri generated valid `icon.icns` and multi-resolution `icon.ico` packages from `hive-source.png`.
- Source-equivalent capture completed through the full onboarding screenshot sequence; the key-import evidence above is the reviewed state.

## Follow-up polish

None required for this screen.

final result: passed

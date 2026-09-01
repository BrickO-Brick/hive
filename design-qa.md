# Hive Navigation Design QA

## Scope

- Target: match the Mantap navigation shell in Hive, including the Brick logo, expanded/collapsed navigation, responsive behavior, and visibility of secondary elements.
- Reference: `/Users/bricko/Work/mantul/sidebar-final-20260705/all-sites/mantap-northstar-top-left.png` plus the Mantap navigation implementation in `/Users/bricko/Work/mantul/mantul-fe`.
- Implementation: `web/src/features/chat/ui/HiveChatPage.tsx` and `web/src/assets/brick-logo.svg`.

## Viewports and states

| Viewport | Density | State | Evidence |
| --- | --- | --- | --- |
| 1280×720 | 1× | desktop expanded | `01-desktop-navigation-expanded.png` |
| 1280×720 | 1× | desktop collapsed | `02-desktop-navigation-collapsed.png` |
| 820×1024 | 1× | tablet collapsed default | `03-tablet-navigation-collapsed.png` |
| 820×1024 | 1× | tablet expanded | `04-tablet-navigation-expanded.png` |
| 390×844 | 1× | mobile drawer closed | `05-mobile-navigation-closed.png` |
| 390×844 | 1× | mobile drawer open | `06-mobile-navigation-open.png` |

The implementation screenshots are under `web/test-results/smoke-Hive-shows-BrickO-realtime-activity-from-relay-signals-smoke/`. The combined responsive state sheet is `.codex/visualizations/2026/09/02/hive-navigation/responsive-navigation-states.png`.

## Comparison evidence

- Full-state comparison: all six responsive states were reviewed together in `responsive-navigation-states.png`.
- Focused comparison: the Mantap reference and the Hive desktop-expanded navigation crop were reviewed side by side in `.codex/visualizations/2026/09/02/hive-navigation/mantap-vs-hive-navigation.png`.
- Interaction coverage: desktop and tablet expansion/collapse, persisted preference, mobile open/close drawer, backdrop, and Escape dismissal.

## Fidelity review

- Fonts and typography: Hive keeps its existing system typography while matching Mantap's uppercase section labels, compact hierarchy, weights, and navigation density. No clipped or cramped navigation copy was observed.
- Spacing and layout: expanded and collapsed widths match Mantap's 200px and 52px shell. Header heights match the 72px and 60px states. The logo, toggle, active item, agent card, and footer retain stable alignment across all tested widths.
- Viewport resilience: desktop, tablet, and mobile screenshots show no overlap, clipping, horizontal overflow, or unusable controls. Tablet defaults to the compact rail; mobile uses a 280px drawer and dimmed backdrop.
- Colors and tokens: the active navigation state uses Mantap's blue foreground, pale-blue fill, blue border, and left accent. Borders, muted text, online green, and white surfaces remain consistent with the source.
- Image quality and assets: Hive uses the exact Mantap Brick logo SVG copied from the source repository. It stays sharp at desktop, tablet, and mobile sizes; no placeholder or custom-drawn brand asset is used.
- Copy and content: navigation wording is specific to Hive (`Percakapan`, `Agent activity`, `BrickO`) while keeping Mantap's information hierarchy. Expanded-only status detail is intentionally hidden in compact mode.
- Icons: Lucide icons use a consistent stroke family, optical size, and alignment. Expanded/collapsed controls have explicit labels and state-appropriate icons.
- States and interactions: expanded/collapsed navigation and mobile drawer controls are functional and covered by smoke tests. The mobile backdrop and Escape key provide additional dismissal paths.
- Accessibility: controls are semantic buttons with accessible labels, focus rings, and practical tap targets. Decorative icons are hidden from assistive technology; the Brick logo has meaningful alt text.

## Findings and iteration history

Pass 1 found no P0, P1, or P2 visual or interaction defects in the local build. The reference screenshot is dimmed by Mantap's PIN overlay, so exact source tokens and dimensions were also verified from the Mantap implementation rather than inferred from the overlay.

Pass 2 checked the first production rollout and found that the relay's static-file allowlist did not serve a root-level `/logo.svg`. The logo was moved into the Vite asset graph so it is emitted as a hashed `/assets/*` file, which the production relay serves. The complete build and six-state smoke screenshot pass then succeeded again.

## Final result

passed

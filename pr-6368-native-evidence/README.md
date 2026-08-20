# PR #6368 native keyboard evidence (sanitized public bundle)

Exact head: `ffb765e49e2db60fdb167fe58440f3c6d5efa17b`.

The native Tauri/WKWebView harness focused the adjacent row action, delivered macOS Tab (`key code 48`), asserted an entity-specific focused `AXCheckBox`, measured 732 bright focus-ring pixels, delivered Space (`key code 49`), and asserted checkbox value `1`, heading `1 task`, and `Clear selection`.

`exact-journey.mp4` is the complete 30-second interaction timeline cropped to the checkbox region so no workspace content is published on this public OSS PR. `exact-focus-crop.png` and `exact-selected-crop.png` show the focused and selected pixels. Semantic snapshots preserve the entity-specific `Open task` / `Select` prefixes while redacting the fixture title.

The feature-specific `mutant.patch` removes only `group-focus-within:opacity-100`. The same native harness then exited `1`: Tab still reached the named AX checkbox, but the visual measurement fell from 732 to 0 pixels. Restoring the class returned the harness to exit `0` and 732 pixels.

Artifacts:
- exact, mutant, and restored receipts plus AX snapshots
- exact, mutant, and restored step diagnostics
- native harness source and feature-specific mutant patch
- sanitized MP4 and focus/selected/mutant crops
- environment/isolation and cleanup records
- SHA-256 manifest

/**
 * Pure resolution logic for preview-feature visibility.
 * No side effects — safe to test in isolation.
 *
 * The manifest (`preview-features.json`) lists only preview features.
 * Anything not in the manifest is stable and resolves true elsewhere
 * (see `useFeatureEnabled`). Once you're inside `resolveEnabled`, the
 * feature IS in the manifest — preview by definition.
 *
 * Build availability is mandatory. Within an eligible build, an explicit user
 * override wins; otherwise the feature's manifest default is used (false when
 * omitted).
 */
import type { FeatureDefinition } from "./types";

export function resolveEnabled(
  feature: FeatureDefinition,
  overrides: Record<string, boolean>,
  buildAvailable: boolean,
): boolean {
  // Strict equality is intentional: JavaScript callers that omit the
  // capability argument fail closed instead of recreating a build-gate side
  // door outside TypeScript.
  if (buildAvailable !== true) return false;
  return overrides[feature.id] ?? feature.defaultEnabled ?? false;
}

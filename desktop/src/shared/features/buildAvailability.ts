import type { FeatureBuildFlag, FeatureDefinition } from "./types";

export type FeatureBuildFlags = Record<FeatureBuildFlag, boolean>;

/**
 * Build capabilities are deliberately separate from user preference. A local
 * storage override cannot make an unavailable feature visible.
 */
export function isFeatureBuildAvailable(
  feature: FeatureDefinition,
  buildFlags: FeatureBuildFlags,
): boolean {
  const requiredFlag = feature.requiredBuildFlag;
  return requiredFlag ? buildFlags[requiredFlag] : true;
}

export function filterBuildAvailableFeatures(
  features: FeatureDefinition[],
  buildFlags: FeatureBuildFlags,
): FeatureDefinition[] {
  return features.filter((feature) =>
    isFeatureBuildAvailable(feature, buildFlags),
  );
}

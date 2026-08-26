import {
  filterBuildAvailableFeatures,
  isFeatureBuildAvailable,
  type FeatureBuildFlags,
} from "./buildAvailability";
import { desktopFeatures } from "./manifest";

const runtimeBuildFlags: FeatureBuildFlags = {
  bestie: import.meta.env.VITE_BUZZ_BESTIE === "1",
};

export function isFeatureAvailableInThisBuild(
  feature: Parameters<typeof isFeatureBuildAvailable>[0],
): boolean {
  return isFeatureBuildAvailable(feature, runtimeBuildFlags);
}

export const availableDesktopFeatures = filterBuildAvailableFeatures(
  desktopFeatures,
  runtimeBuildFlags,
);

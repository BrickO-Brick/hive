/** Platforms a feature is available on */
export type FeaturePlatform = "desktop" | "mobile";

/** Build-time capabilities that can make a preview available to users. */
export type FeatureBuildFlag = "bestie";

/**
 * A single feature definition from the manifest.
 *
 * The manifest (`preview-features.json`) lists ONLY preview features —
 * membership signals "this needs gating." Anything not in the manifest is
 * treated as stable and renders unconditionally (fail-open).
 */
export interface FeatureDefinition {
  id: string;
  name: string;
  description: string;
  /** Whether the preview is enabled when the user has not chosen an override */
  defaultEnabled?: boolean;
  /** If omitted, feature is available on all platforms */
  platforms?: FeaturePlatform[];
  /** If present, the build must opt in before the user can see or enable it */
  requiredBuildFlag?: FeatureBuildFlag;
}

/** The root manifest schema */
export interface FeaturesManifest {
  version: number;
  features: FeatureDefinition[];
}

export const BUZZ_RELEASES_URL =
  "https://github.com/BrickO-Brick/hive/releases";
const BUZZ_RELEASES_API_URL =
  "https://api.github.com/repos/BrickO-Brick/hive/releases?per_page=10";
const CACHE_KEY = "hive.latestDownload.v2";
const CACHE_TTL_MS = 60 * 60 * 1000;

export type BuzzDownloadPlatform = {
  operatingSystem: "linux" | "macos" | "windows" | "unknown";
  architecture: "arm64" | "x64" | "unknown";
};

export type GitHubRelease = {
  draft: boolean;
  prerelease: boolean;
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  assets: Array<{ name: string; browser_download_url: string }>;
};

export type HiveDesktopRelease = {
  version: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  releaseUrl: string;
  downloads: Partial<Record<"macArm64" | "macX64" | "windowsX64", string>>;
};

type UserAgentData = {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ architecture?: string; bitness?: string }>;
};

function normalizeOperatingSystem(
  navigatorValue: Navigator,
  userAgentData?: UserAgentData,
): BuzzDownloadPlatform["operatingSystem"] {
  const userAgent = navigatorValue.userAgent.toLowerCase();
  const platform = (
    userAgentData?.platform ??
    navigatorValue.platform ??
    ""
  ).toLowerCase();

  // Compatibility tokens are treacherous: iPadOS can report MacIntel and a
  // Macintosh UA, while Android and ChromeOS expose Linux platform strings.
  // Reject non-desktop devices before admitting desktop-looking signals.
  const isIPadDesktopMode =
    platform === "macintel" && navigatorValue.maxTouchPoints > 1;
  const isUnsupportedDevice =
    userAgentData?.mobile === true ||
    isIPadDesktopMode ||
    /android|iphone|ipad|ipod|mobile|tablet|windows phone|iemobile|opera mini|opera mobi|webos|blackberry|bb10|kindle|silk|kaios|cros/.test(
      userAgent,
    );
  if (isUnsupportedDevice) return "unknown";

  if (
    platform === "macos" ||
    platform.startsWith("mac") ||
    userAgent.includes("macintosh")
  )
    return "macos";
  if (
    platform === "windows" ||
    platform.startsWith("win") ||
    userAgent.includes("windows nt")
  )
    return "windows";
  if (
    platform === "linux" ||
    platform.startsWith("linux") ||
    userAgent.includes("linux")
  )
    return "linux";
  return "unknown";
}

function normalizeArchitecture(
  value: string,
): BuzzDownloadPlatform["architecture"] {
  const normalized = value.toLowerCase();
  if (/arm|aarch64/.test(normalized)) return "arm64";
  if (/x86|x64|amd64|64/.test(normalized)) return "x64";
  return "unknown";
}

export async function detectBuzzDownloadPlatform(
  navigatorValue: Navigator,
): Promise<BuzzDownloadPlatform> {
  const userAgentData = (
    navigatorValue as Navigator & { userAgentData?: UserAgentData }
  ).userAgentData;
  const operatingSystem = normalizeOperatingSystem(
    navigatorValue,
    userAgentData,
  );
  let architecture = normalizeArchitecture(navigatorValue.userAgent);

  if (userAgentData?.getHighEntropyValues) {
    try {
      const values = await userAgentData.getHighEntropyValues([
        "architecture",
        "bitness",
      ]);
      architecture = normalizeArchitecture(
        `${values.architecture ?? ""} ${values.bitness ?? ""}`,
      );
    } catch {
      // Privacy settings may reject high-entropy client hints. The matcher
      // below applies the safest compatible fallback for the detected OS.
    }
  }

  return { operatingSystem, architecture };
}

function assetPattern(platform: BuzzDownloadPlatform): RegExp | undefined {
  switch (platform.operatingSystem) {
    case "macos":
      if (platform.architecture === "arm64") return /_aarch64\.dmg$/i;
      if (platform.architecture === "x64") return /_x64\.dmg$/i;
      return undefined;
    case "windows":
      return /_x64-setup[^/]*\.exe$/i;
    case "linux":
      return platform.architecture === "arm64"
        ? undefined
        : /_amd64\.AppImage$/i;
    default:
      return undefined;
  }
}

function releaseAssetUrl(release: GitHubRelease, pattern: RegExp) {
  return release.assets.find(({ name }) => pattern.test(name))
    ?.browser_download_url;
}

export function selectLatestHiveDesktopRelease(
  releases: GitHubRelease[],
): HiveDesktopRelease | null {
  const release = releases.find(
    ({ draft, prerelease, tag_name: tagName }) =>
      !draft && !prerelease && /^desktop-v\d+\.\d+\.\d+$/.test(tagName ?? ""),
  );
  if (!release?.tag_name) return null;

  return {
    version: release.tag_name.replace(/^desktop-v/, ""),
    name:
      release.name?.trim() ||
      `Hive ${release.tag_name.replace(/^desktop-v/, "")}`,
    notes: release.body?.trim() || "A more polished Hive desktop experience.",
    publishedAt: release.published_at ?? null,
    releaseUrl: release.html_url ?? BUZZ_RELEASES_URL,
    downloads: {
      macArm64: releaseAssetUrl(release, /_aarch64\.dmg$/i),
      macX64: releaseAssetUrl(release, /_x64\.dmg$/i),
      windowsX64: releaseAssetUrl(release, /_x64-setup[^/]*\.exe$/i),
    },
  };
}

export async function fetchLatestHiveDesktopRelease(): Promise<HiveDesktopRelease | null> {
  const response = await fetch(BUZZ_RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return null;
  return selectLatestHiveDesktopRelease(
    (await response.json()) as GitHubRelease[],
  );
}

export function selectBuzzDownloadUrl(
  releases: GitHubRelease[],
  platform: BuzzDownloadPlatform,
): string | undefined {
  const pattern = assetPattern(platform);
  if (!pattern) return undefined;

  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const asset = release.assets.find(({ name }) => pattern.test(name));
    if (asset) return asset.browser_download_url;
  }
  return undefined;
}

export async function resolveBuzzDownloadUrlForPlatform(
  platform: BuzzDownloadPlatform,
): Promise<string> {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? "null") as {
      expiresAt: number;
      platform: BuzzDownloadPlatform;
      url: string;
    } | null;
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.platform.operatingSystem === platform.operatingSystem &&
      cached.platform.architecture === platform.architecture
    ) {
      return cached.url;
    }
  } catch {
    // Storage is only an optimization.
  }

  try {
    const response = await fetch(BUZZ_RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return BUZZ_RELEASES_URL;
    const url = selectBuzzDownloadUrl(
      (await response.json()) as GitHubRelease[],
      platform,
    );
    if (!url) return BUZZ_RELEASES_URL;
    try {
      sessionStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          expiresAt: Date.now() + CACHE_TTL_MS,
          platform,
          url,
        }),
      );
    } catch {
      // Storage is only an optimization.
    }
    return url;
  } catch {
    return BUZZ_RELEASES_URL;
  }
}

export async function resolveBuzzDownloadUrl(): Promise<string> {
  return resolveBuzzDownloadUrlForPlatform(
    await detectBuzzDownloadPlatform(navigator),
  );
}

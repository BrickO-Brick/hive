import { useQuery } from "@tanstack/react-query";

import { useIdentityQuery } from "@/shared/api/hooks";
import { discoverAdminOrigin, getAdminOrigin, probeAdminOrigin } from "./api";
import type { ModerationNavResolution } from "./nav";

export const moderationNavResolutionQueryKey = (pubkeyHex: string) =>
  ["moderationNavResolution", pubkeyHex] as const;

/**
 * Resolve the origin + probe state that decide whether the Moderation nav
 * entry is visible. Mirrors the settings card's mount resolution: a saved
 * manual origin wins outright (and short-circuits the probe, since the gate
 * shows the entry regardless); otherwise NIP-11 discovery is attempted and,
 * when it advertises an origin, probed so the gate can distinguish an
 * authorized relay from a definitive non-admin verdict.
 *
 * Keyed by pubkey so an identity switch re-resolves. Errors from the probe
 * resolve to a `"error"` outcome rather than rejecting — a transport flake
 * must keep the entry visible, not make the whole query fail.
 */
export function useModerationNavResolution():
  | ModerationNavResolution
  | undefined {
  const { data: identity } = useIdentityQuery();
  const pubkeyHex = identity?.pubkey ?? "";

  const query = useQuery({
    enabled: pubkeyHex.length > 0,
    queryKey: moderationNavResolutionQueryKey(pubkeyHex),
    staleTime: 60_000,
    queryFn: async (): Promise<ModerationNavResolution> => {
      const saved = await getAdminOrigin(pubkeyHex);
      if (saved) {
        return { originSource: "saved", probe: null };
      }
      let discovered: string | null = null;
      try {
        discovered = await discoverAdminOrigin();
      } catch {
        discovered = null;
      }
      if (!discovered) {
        return { originSource: "none", probe: null };
      }
      try {
        const result = await probeAdminOrigin(discovered);
        return { originSource: "advertised", probe: result.state };
      } catch {
        return { originSource: "advertised", probe: "error" };
      }
    },
  });

  return query.data;
}

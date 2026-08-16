const PROJECT_SIDEBAR_MEMBERSHIP_PREFIX = "buzz.sidebar.projects.membership.v1";
export const PROJECT_SIDEBAR_MEMBERSHIP_EVENT =
  "buzz:project-sidebar-membership-change";

/** Detail carried by {@link PROJECT_SIDEBAR_MEMBERSHIP_EVENT}: the computed
 * membership for one relay/pubkey scope. Listeners must consume this rather
 * than re-reading localStorage — when persistence fails the write never
 * lands, and re-reading would silently revert the user's add/remove. */
export type ProjectSidebarMembershipChange = {
  relayOrigin: string;
  pubkey: string;
  addresses: string[];
};

function membershipKey(relayOrigin: string, pubkey: string) {
  return `${PROJECT_SIDEBAR_MEMBERSHIP_PREFIX}.${encodeURIComponent(relayOrigin)}.${pubkey.toLowerCase()}`;
}

export function readProjectSidebarMembership(
  relayOrigin: string | null | undefined,
  pubkey: string | null | undefined,
): string[] {
  if (!relayOrigin || !pubkey) return [];
  try {
    const parsed = JSON.parse(
      globalThis.localStorage?.getItem(membershipKey(relayOrigin, pubkey)) ??
        "[]",
    );
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter(
              (address): address is string =>
                typeof address === "string" && address.length > 0,
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

function writeProjectSidebarMembership(
  relayOrigin: string,
  pubkey: string,
  addresses: readonly string[],
) {
  const deduped = [...new Set(addresses)];
  try {
    globalThis.localStorage?.setItem(
      membershipKey(relayOrigin, pubkey),
      JSON.stringify(deduped),
    );
  } catch {
    // Persistence is best-effort; the change event below still updates every
    // mounted view so add/remove is never a visible no-op.
  }
  globalThis.dispatchEvent?.(
    new CustomEvent<ProjectSidebarMembershipChange>(
      PROJECT_SIDEBAR_MEMBERSHIP_EVENT,
      { detail: { addresses: deduped, pubkey, relayOrigin } },
    ),
  );
}

export function addProjectToSidebar(
  projectAddress: string,
  relayOrigin: string | null | undefined,
  pubkey: string | null | undefined,
) {
  if (!relayOrigin || !pubkey) return;
  writeProjectSidebarMembership(relayOrigin, pubkey, [
    ...readProjectSidebarMembership(relayOrigin, pubkey),
    projectAddress,
  ]);
}

export function removeProjectFromSidebar(
  projectAddress: string,
  relayOrigin: string | null | undefined,
  pubkey: string | null | undefined,
) {
  if (!relayOrigin || !pubkey) return;
  writeProjectSidebarMembership(
    relayOrigin,
    pubkey,
    readProjectSidebarMembership(relayOrigin, pubkey).filter(
      (address) => address !== projectAddress,
    ),
  );
}

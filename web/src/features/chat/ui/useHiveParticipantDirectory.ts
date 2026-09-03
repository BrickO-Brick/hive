import { useEffect, useMemo, useState } from "react";
import {
  queryEvents,
  subscribeEvents,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relayWsUrl } from "@/shared/lib/relay-url";

type HiveIdentity = {
  channelId: string;
  pubkey: string;
};

export type ParticipantProfile = {
  createdAt: number;
  displayName: string | null;
  nip05: string | null;
};

export function normalizePubkey(pubkey: string): string {
  return pubkey.trim().toLowerCase();
}

export function participantInitials(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function participantPresentation(
  pubkey: string,
  identityPubkey: string,
  agentPubkey: string | null,
  profiles: Record<string, ParticipantProfile>,
) {
  const normalized = normalizePubkey(pubkey);
  const mine = normalized === normalizePubkey(identityPubkey);
  const fromBrickO =
    agentPubkey !== null && normalized === normalizePubkey(agentPubkey);
  const authorLabel = mine
    ? "You"
    : fromBrickO
      ? "BrickO"
      : (profiles[normalized]?.displayName ??
        profiles[normalized]?.nip05 ??
        `Member ${truncatePubkey(pubkey)}`);
  return { authorLabel, fromBrickO, mine };
}

function memberRoles(event: NostrEvent): Record<string, string> {
  return Object.fromEntries(
    event.tags
      .filter((tag) => tag[0] === "p" && tag[1] && tag[3])
      .map((tag) => [normalizePubkey(tag[1] ?? ""), tag[3] ?? ""]),
  );
}

function profile(event: NostrEvent): ParticipantProfile | null {
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    const displayNameValue = content.display_name ?? content.name;
    const nip05Value = content.nip05;
    return {
      createdAt: event.created_at,
      displayName:
        typeof displayNameValue === "string" && displayNameValue.trim()
          ? displayNameValue.trim()
          : null,
      nip05:
        typeof nip05Value === "string" && nip05Value.trim()
          ? nip05Value.trim()
          : null,
    };
  } catch {
    return null;
  }
}

export function useHiveParticipantDirectory(
  identity: HiveIdentity | null,
  messages: NostrEvent[],
) {
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<Record<string, ParticipantProfile>>(
    {},
  );

  useEffect(() => {
    if (!identity) return;
    let active = true;
    let newestRosterAt = 0;
    const apply = (event: NostrEvent) => {
      if (!active || event.created_at < newestRosterAt) return;
      newestRosterAt = event.created_at;
      setRoles(memberRoles(event));
    };
    void queryEvents(relayWsUrl(), {
      kinds: [39002],
      "#d": [identity.channelId],
      limit: 1,
    }).then(
      (events) => {
        const latest = events.reduce<NostrEvent | null>(
          (current, event) =>
            !current || event.created_at > current.created_at ? event : current,
          null,
        );
        if (latest) apply(latest);
      },
      () => {},
    );
    const unsubscribe = subscribeEvents(
      relayWsUrl(),
      { kinds: [39002], "#d": [identity.channelId] },
      apply,
      () => {},
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [identity]);

  const requestedPubkeys = useMemo(() => {
    const pubkeys = new Set(
      messages.map(({ pubkey }) => normalizePubkey(pubkey)),
    );
    for (const [pubkey, role] of Object.entries(roles)) {
      if (role === "bot") pubkeys.add(pubkey);
    }
    if (identity) pubkeys.add(normalizePubkey(identity.pubkey));
    return [...pubkeys].filter(Boolean).sort().join(",");
  }, [identity, messages, roles]);

  useEffect(() => {
    const authors = requestedPubkeys.split(",").filter(Boolean);
    if (authors.length === 0) return;
    let active = true;
    const apply = (event: NostrEvent) => {
      const next = profile(event);
      if (!active || !next) return;
      const pubkey = normalizePubkey(event.pubkey);
      setProfiles((current) =>
        (current[pubkey]?.createdAt ?? -1) > next.createdAt
          ? current
          : { ...current, [pubkey]: next },
      );
    };
    void queryEvents(relayWsUrl(), {
      kinds: [0],
      authors,
      limit: authors.length,
    }).then(
      (events) => events.forEach(apply),
      () => {},
    );
    const unsubscribe = subscribeEvents(
      relayWsUrl(),
      { kinds: [0], authors },
      apply,
      () => {},
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [requestedPubkeys]);

  const agentPubkey = useMemo(() => {
    const bots = Object.entries(roles)
      .filter(([, role]) => role === "bot")
      .map(([pubkey]) => pubkey);
    const named = bots.filter(
      (pubkey) => profiles[pubkey]?.displayName?.toLowerCase() === "bricko",
    );
    if (named.length === 1) return named[0] ?? null;
    return bots.length === 1 ? (bots[0] ?? null) : null;
  }, [profiles, roles]);

  return { agentPubkey, profiles };
}

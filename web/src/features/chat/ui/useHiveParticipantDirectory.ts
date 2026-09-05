import { useEffect, useMemo, useState } from "react";
import {
  queryEvents,
  subscribeEvents,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { useOneBrickParticipants } from "../onebrick-participants-api";

type HiveIdentity = {
  channelId: string;
  pubkey: string;
};

export type ParticipantProfile = {
  createdAt: number;
  displayName: string | null;
  nip05: string | null;
};

export type HiveParticipant = {
  displayName: string;
  identityHint: string;
  isAgent: boolean;
  isCurrentUser: boolean;
  linkedPubkeys: string[];
  pubkey: string;
  role: string;
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
        `Teammate · ${truncatePubkey(pubkey)}`);
  return { authorLabel, fromBrickO, mine };
}

export function participantsInPrivateChat(
  participants: HiveParticipant[],
  participantPubkeys: string[] | undefined,
): HiveParticipant[] {
  if (!participantPubkeys) return participants;
  const allowed = new Set(participantPubkeys.map(normalizePubkey));
  return participants.filter((participant) =>
    participant.linkedPubkeys.some((pubkey) =>
      allowed.has(normalizePubkey(pubkey)),
    ),
  );
}

export function privateChatIncludes(
  participantPubkeys: string[] | undefined,
  pubkey: string | null,
): boolean {
  return Boolean(
    pubkey &&
      participantPubkeys
        ?.map(normalizePubkey)
        .includes(normalizePubkey(pubkey)),
  );
}

export function messageAuthorLabel(
  message: NostrEvent | null,
  currentPubkey: string,
  agentPubkey: string | null,
  profiles: Record<string, ParticipantProfile>,
): string {
  return message
    ? participantPresentation(
        message.pubkey,
        currentPubkey,
        agentPubkey,
        profiles,
      ).authorLabel
    : "";
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
  const directory = useOneBrickParticipants(identity?.channelId ?? null);
  const [eventRoles, setEventRoles] = useState<Record<string, string>>({});
  const [nostrProfiles, setNostrProfiles] = useState<
    Record<string, ParticipantProfile>
  >({});

  useEffect(() => {
    if (!identity) return;
    let active = true;
    let newestRosterAt = 0;
    const apply = (event: NostrEvent) => {
      if (!active || event.created_at < newestRosterAt) return;
      newestRosterAt = event.created_at;
      setEventRoles(memberRoles(event));
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
    for (const pubkey of Object.keys(eventRoles)) {
      pubkeys.add(pubkey);
    }
    for (const participant of directory.data ?? []) {
      for (const pubkey of participant.linkedPubkeys ?? [participant.pubkey]) {
        pubkeys.add(normalizePubkey(pubkey));
      }
    }
    if (identity) pubkeys.add(normalizePubkey(identity.pubkey));
    return [...pubkeys].filter(Boolean).sort().join(",");
  }, [directory.data, eventRoles, identity, messages]);

  useEffect(() => {
    const authors = requestedPubkeys.split(",").filter(Boolean);
    if (authors.length === 0) return;
    let active = true;
    const apply = (event: NostrEvent) => {
      const next = profile(event);
      if (!active || !next) return;
      const pubkey = normalizePubkey(event.pubkey);
      setNostrProfiles((current) =>
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

  const roles = useMemo(() => {
    const serverRoles = Object.fromEntries(
      (directory.data ?? []).flatMap((participant) =>
        (participant.linkedPubkeys ?? [participant.pubkey]).map((pubkey) => [
          normalizePubkey(pubkey),
          participant.role,
        ]),
      ),
    );
    return { ...serverRoles, ...eventRoles };
  }, [directory.data, eventRoles]);

  const profiles = useMemo(() => {
    const serverProfiles = Object.fromEntries(
      (directory.data ?? []).flatMap((participant) =>
        (participant.linkedPubkeys ?? [participant.pubkey]).map((pubkey) => [
          normalizePubkey(pubkey),
          {
            createdAt: 0,
            displayName: participant.displayName,
            nip05: null,
          } satisfies ParticipantProfile,
        ]),
      ),
    );
    return { ...serverProfiles, ...nostrProfiles };
  }, [directory.data, nostrProfiles]);

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

  const participants = useMemo<HiveParticipant[]>(() => {
    const ownPubkey = identity ? normalizePubkey(identity.pubkey) : "";
    const pubkeys = new Set(Object.keys(roles));
    if (ownPubkey) pubkeys.add(ownPubkey);
    for (const message of messages)
      pubkeys.add(normalizePubkey(message.pubkey));
    const groupedPubkeys = new Set<string>();
    const groupedParticipants = (directory.data ?? []).map((entry) => {
      const linkedPubkeys = (entry.linkedPubkeys ?? [entry.pubkey])
        .map(normalizePubkey)
        .filter(Boolean);
      for (const pubkey of linkedPubkeys) groupedPubkeys.add(pubkey);
      const pubkey = normalizePubkey(entry.pubkey);
      const isCurrentUser = linkedPubkeys.includes(ownPubkey);
      const isAgent = linkedPubkeys.includes(agentPubkey ?? "");
      const fallback = isCurrentUser
        ? "You"
        : isAgent
          ? "BrickO"
          : `Teammate · ${truncatePubkey(pubkey)}`;
      const displayName =
        entry.displayName ??
        profiles[pubkey]?.displayName ??
        profiles[pubkey]?.nip05 ??
        fallback;
      return {
        displayName,
        identityHint:
          linkedPubkeys.length > 1
            ? `${linkedPubkeys.length} linked devices`
            : (profiles[pubkey]?.nip05 ?? truncatePubkey(pubkey)),
        isAgent,
        isCurrentUser,
        linkedPubkeys,
        pubkey,
        role: isAgent ? "Agent" : entry.role,
      };
    });
    const ungroupedParticipants = [...pubkeys]
      .filter((pubkey) => Boolean(pubkey) && !groupedPubkeys.has(pubkey))
      .map((pubkey) => {
        const isCurrentUser = pubkey === ownPubkey;
        const isAgent = pubkey === agentPubkey;
        const fallback = isCurrentUser
          ? "You"
          : isAgent
            ? "BrickO"
            : `Teammate · ${truncatePubkey(pubkey)}`;
        const displayName =
          profiles[pubkey]?.displayName ?? profiles[pubkey]?.nip05 ?? fallback;
        const profileHandle = profiles[pubkey]?.nip05;
        return {
          displayName,
          identityHint:
            profileHandle && profileHandle !== displayName
              ? profileHandle
              : truncatePubkey(pubkey),
          isAgent,
          isCurrentUser,
          linkedPubkeys: [pubkey],
          pubkey,
          role: isAgent ? "Agent" : (roles[pubkey] ?? "member"),
        };
      });
    return [...groupedParticipants, ...ungroupedParticipants].sort(
      (left, right) => {
        if (left.isAgent !== right.isAgent) return left.isAgent ? -1 : 1;
        if (left.isCurrentUser !== right.isCurrentUser) {
          return left.isCurrentUser ? 1 : -1;
        }
        return left.displayName.localeCompare(right.displayName);
      },
    );
  }, [agentPubkey, directory.data, identity, messages, profiles, roles]);

  return { agentPubkey, participants, profiles };
}

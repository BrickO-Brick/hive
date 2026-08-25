import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { channelsQueryKey } from "@/features/channels/hooks";
import { refreshChannelsWhenIdle } from "@/features/channels/refreshChannelsWhenIdle";
import { getChannelIdFromTags } from "@/features/messages/lib/threading";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import {
  createTrailingDebounce,
  type TrailingDebounce,
} from "@/shared/lib/trailingDebounce";
import {
  KIND_DM_VISIBILITY,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
} from "@/shared/constants/kinds";

const MEMBERSHIP_NOTIFICATION_RETRY_BASE_MS = 1_000;
const MEMBERSHIP_NOTIFICATION_RETRY_MAX_MS = 30_000;
// Matches useLiveChannelUpdates: collapse a burst of notifications into a
// single trailing refresh once the channels query goes idle.
const CHANNELS_INVALIDATE_DEBOUNCE_MS = 500;

export function useMembershipNotifications(currentPubkey?: string) {
  const queryClient = useQueryClient();
  const normalizedCurrentPubkey = currentPubkey?.trim().toLowerCase() ?? "";

  // Route channel-list invalidation through the idle-aware trailing mechanism
  // rather than invalidating directly. A direct invalidate while get_channels
  // is mid-flight is silently undone when the older (pre-event) response lands
  // and clears the dirty flag — dropping the resurface signal so an incoming
  // DM stays out of navigation until the next poll. This mirrors ordinary live
  // channel traffic (useLiveChannelUpdates), which invalidates the same key.
  const channelsInvalidateRef = React.useRef<TrailingDebounce | null>(null);
  if (channelsInvalidateRef.current === null) {
    channelsInvalidateRef.current = createTrailingDebounce(() => {
      refreshChannelsWhenIdle({
        isFetching: () =>
          queryClient.isFetching({ queryKey: channelsQueryKey }),
        invalidate: () => {
          void queryClient.invalidateQueries({ queryKey: channelsQueryKey });
        },
        reArm: () => channelsInvalidateRef.current?.trigger(),
      });
    }, CHANNELS_INVALIDATE_DEBOUNCE_MS);
  }

  const handleMembershipNotification = React.useEffectEvent(
    (event: RelayEvent) => {
      const channelId = getChannelIdFromTags(event.tags);

      channelsInvalidateRef.current?.trigger();
      if (event.kind === KIND_DM_VISIBILITY) {
        return;
      }
      if (!channelId) {
        return;
      }

      void queryClient.invalidateQueries({
        queryKey: ["channels", channelId, "detail"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["channels", channelId, "members"],
      });
    },
  );

  React.useEffect(() => {
    if (normalizedCurrentPubkey.length === 0) {
      return;
    }

    let isCancelled = false;
    let retryTimeout: number | undefined;
    let retryAttempt = 0;
    let dispose: (() => Promise<void>) | undefined;

    const subscribe = async (): Promise<boolean> => {
      const nextDisposes: Array<() => Promise<void>> = [];
      try {
        const handleEvent = (event: RelayEvent) => {
          if (!isCancelled) {
            handleMembershipNotification(event);
          }
        };
        nextDisposes.push(
          await relayClient.subscribeLive(
            {
              kinds: [
                KIND_MEMBER_ADDED_NOTIFICATION,
                KIND_MEMBER_REMOVED_NOTIFICATION,
              ],
              "#p": [normalizedCurrentPubkey],
              limit: 50,
              since: Math.floor(Date.now() / 1_000) - 30,
            },
            handleEvent,
          ),
        );
        nextDisposes.push(
          await relayClient.subscribeLive(
            {
              kinds: [KIND_DM_VISIBILITY],
              "#p": [normalizedCurrentPubkey],
              // A separate one-event replay closes the history/subscription
              // gap without sharing membership notifications' replay budget.
              limit: 1,
            },
            handleEvent,
          ),
        );
        const nextDispose = async () => {
          await Promise.all(
            nextDisposes.map((unsubscribe) =>
              unsubscribe().catch(() => undefined),
            ),
          );
        };
        if (isCancelled) {
          void nextDispose();
          return true;
        }
        dispose = nextDispose;
        return true;
      } catch (error) {
        await Promise.all(
          nextDisposes.map((unsubscribe) =>
            unsubscribe().catch(() => undefined),
          ),
        );
        console.error(
          "Failed to subscribe to channel-list notifications",
          error,
        );
        return false;
      }
    };

    const run = async () => {
      const ok = await subscribe();
      if (isCancelled || ok) {
        return;
      }

      const delayMs = Math.min(
        MEMBERSHIP_NOTIFICATION_RETRY_BASE_MS * 2 ** retryAttempt,
        MEMBERSHIP_NOTIFICATION_RETRY_MAX_MS,
      );
      retryAttempt += 1;
      retryTimeout = window.setTimeout(() => {
        retryTimeout = undefined;
        void run();
      }, delayMs);
    };

    void run();

    return () => {
      isCancelled = true;
      if (retryTimeout !== undefined) {
        window.clearTimeout(retryTimeout);
      }
      channelsInvalidateRef.current?.cancel();
      if (dispose) {
        void dispose().catch(() => {});
      }
    };
  }, [normalizedCurrentPubkey]);
}

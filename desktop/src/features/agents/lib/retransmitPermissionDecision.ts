import type { ControlResultFrame } from "@/shared/api/types";

/**
 * Drive a permission decision to the agent harness with a retransmit-until-acked
 * loop, so an owner's click survives a harness socket that is briefly down.
 *
 * The send side is otherwise fire-and-forget: `sendPermissionDecision` publishes
 * one `permission_decision` observer control frame and the harness replies out
 * of band with a `control_result`. Kind-24200 control frames are ephemeral — the
 * relay never stores them — so a frame that reaches the relay while the agent's
 * subscription is down is dropped and never delivered. A single fire-and-forget
 * send therefore has no delivery guarantee: the card would hang until the 300 s
 * fail-closed timeout even though the owner decided promptly.
 *
 * This orchestrator resends the decision on a fixed cadence until it observes a
 * `control_result` for THIS nonce, then stops. Any matching frame settles the
 * loop — the harness has an authoritative answer (`sent` / `already_decided` =
 * applied; a failure status is handled by the card's retry path), and resending
 * cannot change it. If no reply arrives before the card's own `expiresAt`
 * deadline the loop resolves `"expired"`: the card times out on its own and a
 * decision applied past expiry would be rejected anyway, so retransmitting past
 * it is pointless.
 *
 * A nonce guard scopes the settling frame to this exact decision: a replayed or
 * concurrent `control_result` for a different card carries a different nonce and
 * is inert, mirroring the `requestId` guard in `awaitLiveSwitchOutcome`.
 *
 * A send rejection is the transport failure this loop exists to survive, so the
 * orchestrator never throws: the first send and every retransmit run through
 * the same guarded path, and a rejected attempt is swallowed — the next tick
 * retries. This guarantees exactly one loop per click (the UI's disabled state
 * guards double-click) and no unhandled rejection on any path. Permanent send
 * failure therefore ends the same way as silence: the loop retries until
 * `expiresAt`, then resolves `"expired"` and the card fails closed.
 *
 * The loop is isolated from React and the relay so it can be unit tested with a
 * fake clock and synthetic frames. The caller injects the send, the
 * `control_result` subscription, and the retransmit scheduler.
 */
export function retransmitPermissionDecision({
  requestNonce,
  send,
  subscribe,
  scheduleRetransmit,
  deadlineReached,
}: {
  /** Nonce of the decision being delivered; frames without it are ignored. */
  requestNonce: string;
  /** Publish one `permission_decision` frame. Resolves when the send settles. */
  send: () => Promise<void>;
  /** Register a `control_result` listener; returns an unsubscribe function. */
  subscribe: (listener: (frame: ControlResultFrame) => void) => () => void;
  /**
   * Schedule the retransmit cadence; `onTick` fires once per interval. Returns
   * a cancel function. The caller drives the real interval (e.g. every 2 s).
   */
  scheduleRetransmit: (onTick: () => void) => () => void;
  /**
   * Whether the card's `expiresAt` deadline has passed. Checked before each
   * retransmit so the loop never resends past expiry.
   */
  deadlineReached: () => boolean;
}): Promise<"acked" | "expired"> {
  return new Promise<"acked" | "expired">((resolve) => {
    let unsubscribe = () => {};
    let cancelRetransmit = () => {};
    const finish = (outcome: "acked" | "expired") => {
      cancelRetransmit();
      unsubscribe();
      resolve(outcome);
    };
    // Attempt one transmit, respecting the deadline and swallowing a rejected
    // send. A rejection is a failed transmit, not a fatal error: the next tick
    // retries, so the loop survives a socket that is briefly down.
    const transmit = () => {
      if (deadlineReached()) {
        finish("expired");
        return;
      }
      void send().catch(() => {});
    };
    unsubscribe = subscribe((frame) => {
      // A `control_result` for THIS nonce means the harness received the
      // decision and has an authoritative answer — stop retransmitting. Frames
      // for other cards (or non-permission frames) carry a different nonce (or
      // none) and are inert.
      if (
        frame.type !== "permission_decision" ||
        frame.requestNonce !== requestNonce
      ) {
        return;
      }
      finish("acked");
    });
    cancelRetransmit = scheduleRetransmit(transmit);

    // Fire the first send immediately, then let the scheduler drive resends.
    transmit();
  });
}

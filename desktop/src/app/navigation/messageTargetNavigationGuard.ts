export type MessageTargetNavigation =
  | {
      kind: "channel-message";
      channelId: string;
      messageId: string;
      threadRootId: string | null;
    }
  | {
      kind: "forum-post";
      channelId: string;
      postId: string;
      replyId: string | null;
    };

type MessageTargetNavigationGuard = (
  target: MessageTargetNavigation,
) => boolean;

type GuardRegistration = {
  guard: MessageTargetNavigationGuard;
};

const activeGuards: GuardRegistration[] = [];

export function allowMessageTargetNavigation(
  target: MessageTargetNavigation,
): boolean {
  return activeGuards.at(-1)?.guard(target) ?? true;
}

export function registerMessageTargetNavigationGuard(
  guard: MessageTargetNavigationGuard,
): () => void {
  const registration = { guard };
  activeGuards.push(registration);
  return () => {
    const index = activeGuards.lastIndexOf(registration);
    if (index >= 0) activeGuards.splice(index, 1);
  };
}

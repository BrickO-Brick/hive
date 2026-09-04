export function hiveUserFacingError(
  cause: unknown,
  action: "connect" | "load" | "send" | "create",
): string {
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (message.includes("auth")) {
    return "Your Hive session needs attention. Sign in again before retrying.";
  }
  if (action === "connect") {
    return "Chat connection interrupted. Your draft is safe; Hive will reconnect automatically.";
  }
  if (action === "send") {
    return "Message not sent. Your draft is safe; check the chat connection and try again.";
  }
  if (action === "create") {
    return "Hive could not create this discussion. Nothing was changed; please try again.";
  }
  return "Hive could not load the latest messages. Existing messages remain available; please refresh.";
}

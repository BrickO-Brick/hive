const FAILURE_PREFIXES = [
  "⚠️ I couldn't process the last request",
  "⚠️ BrickO could not complete this request",
] as const;

export function isAgentFailureMessage(content: string): boolean {
  return FAILURE_PREFIXES.some((prefix) =>
    content.trimStart().startsWith(prefix),
  );
}

export function agentFailureDisplayContent(content: string): string {
  if (!isAgentFailureMessage(content)) return content;
  return "⚠️ BrickO could not complete this request. Your original request is still available—restore it below and try again.";
}

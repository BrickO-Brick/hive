type MessageTargetNavigationGuard = () => boolean;

let activeGuard: MessageTargetNavigationGuard | null = null;

export function allowMessageTargetNavigation(): boolean {
  return activeGuard?.() ?? true;
}

export function registerMessageTargetNavigationGuard(
  guard: MessageTargetNavigationGuard,
): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

import * as React from "react";

import type { SearchHit } from "@/shared/api/searchTypes";
import { ProjectConversationPanel } from "./ProjectConversationPanel";

type ProjectConversationPanelContextValue = {
  openConversation: (hit: SearchHit) => void;
};

const ProjectConversationPanelContext =
  React.createContext<ProjectConversationPanelContextValue | null>(null);

/** Makes project-related channel conversations available as an auxiliary panel. */
export function ProjectConversationPanelProvider({
  children,
  onOpenConversation,
}: {
  children: React.ReactNode;
  onOpenConversation: (hit: SearchHit) => void;
}) {
  const value = React.useMemo(
    () => ({ openConversation: onOpenConversation }),
    [onOpenConversation],
  );
  return (
    <ProjectConversationPanelContext.Provider value={value}>
      {children}
    </ProjectConversationPanelContext.Provider>
  );
}

/** Owns project conversation selection and renders the shared auxiliary pane. */
export function ProjectConversationPanelController({
  canResetWidth,
  children,
  closeWhen,
  onOpenConversation,
  onResetWidth,
  onResizeStart,
  resetKey,
  widthPx,
}: {
  canResetWidth: boolean;
  children: React.ReactNode;
  closeWhen: boolean;
  onOpenConversation: () => void;
  onResetWidth: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
  resetKey: string;
  widthPx: number;
}) {
  const [hit, setHit] = React.useState<SearchHit | null>(null);
  const previousResetKeyRef = React.useRef(resetKey);
  React.useEffect(() => {
    const changedContext = previousResetKeyRef.current !== resetKey;
    previousResetKeyRef.current = resetKey;
    if (closeWhen || changedContext) setHit(null);
  }, [closeWhen, resetKey]);
  const openConversation = React.useCallback(
    (nextHit: SearchHit) => {
      onOpenConversation();
      setHit(nextHit);
    },
    [onOpenConversation],
  );
  return (
    <ProjectConversationPanelProvider onOpenConversation={openConversation}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
        {children}
        {hit ? (
          <ProjectConversationPanel
            canResetWidth={canResetWidth}
            hit={hit}
            onClose={() => setHit(null)}
            onResetWidth={onResetWidth}
            onResizeStart={onResizeStart}
            widthPx={widthPx}
          />
        ) : null}
      </div>
    </ProjectConversationPanelProvider>
  );
}

/** Returns null outside project detail, where normal channel navigation remains. */
export function useProjectConversationPanel() {
  return React.useContext(ProjectConversationPanelContext);
}

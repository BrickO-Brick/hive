import { Info, MessageCircle } from "lucide-react";

import {
  toggleTerminalPanel,
  useTerminalPanel,
} from "@/features/terminal/terminalPanelStore";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import terminalIcon from "@/shared/ui/assets/terminal.svg";
import { ProjectRepositoryPanelToggle } from "./ProjectRepositoryPanelToggle";

export type ProjectRightPanelMode = "chat" | "repository";

export function ProjectRightPanelControls({
  collapsed,
  mode,
  onCollapse,
  onExpand,
  onModeChange,
  terminalAvailable,
}: {
  collapsed: boolean;
  mode: ProjectRightPanelMode;
  onCollapse: () => void;
  onExpand: () => void;
  onModeChange: (mode: ProjectRightPanelMode) => void;
  terminalAvailable: boolean;
}) {
  const terminalPanel = useTerminalPanel();
  const terminalOpen = terminalPanel.mode !== "closed";

  return (
    <div className="flex items-center gap-0.5">
      <Button
        aria-label="Show repository information"
        aria-pressed={!collapsed && mode === "repository"}
        className={cn(
          "h-7 w-7 text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          !collapsed &&
            mode === "repository" &&
            "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
        data-testid="project-right-panel-repository-tab"
        onClick={() => {
          onModeChange("repository");
          onExpand();
        }}
        size="icon"
        title="Repository information"
        type="button"
        variant="ghost"
      >
        <Info className="h-4 w-4" />
      </Button>
      <Button
        aria-label="Show project chat"
        aria-pressed={!collapsed && mode === "chat"}
        className={cn(
          "h-7 w-7 text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          !collapsed &&
            mode === "chat" &&
            "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
        data-testid="project-right-panel-chat-tab"
        onClick={() => {
          onModeChange("chat");
          onExpand();
        }}
        size="icon"
        title="Project chat"
        type="button"
        variant="ghost"
      >
        <MessageCircle className="h-4 w-4" />
      </Button>
      <Button
        aria-label={terminalOpen ? "Hide Buzz Term" : "Open Buzz Term"}
        aria-pressed={terminalOpen}
        className={cn(
          "h-7 w-7 text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          terminalOpen && "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
        data-testid="project-terminal-toggle"
        disabled={!terminalAvailable}
        onClick={toggleTerminalPanel}
        size="icon"
        title="Buzz Term (⌘J)"
        type="button"
        variant="ghost"
      >
        <span
          aria-hidden="true"
          className="h-4 w-[1.1rem] bg-current [mask-position:center] [mask-repeat:no-repeat]"
          data-testid="project-terminal-icon"
          style={{
            maskImage: `url("${terminalIcon}")`,
            maskSize: "calc(100% - 2px) calc(100% - 2px)",
            WebkitMaskImage: `url("${terminalIcon}")`,
            WebkitMaskSize: "calc(100% - 2px) calc(100% - 2px)",
          }}
        />
      </Button>
      <ProjectRepositoryPanelToggle
        className="text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        expanded={!collapsed}
        onClick={collapsed ? onExpand : onCollapse}
      />
    </div>
  );
}

import { BookOpen } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { TabsList, TabsTrigger } from "@/shared/ui/tabs";

const PROJECT_TAB_TRIGGER_CLASS =
  "relative h-full shrink-0 rounded-none px-2.5 text-sm leading-5 tracking-tight text-muted-foreground shadow-none after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:bg-current after:opacity-0 after:transition-opacity after:content-[''] hover:bg-transparent hover:text-foreground hover:after:opacity-100 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:opacity-100";

const PROJECT_TAB_SELECTED_CLASS =
  "font-semibold text-foreground after:opacity-100";
const PROJECT_OVERVIEW_TAB_CLASS =
  "h-8 w-8 shrink-0 rounded-md p-2 text-muted-foreground shadow-none hover:bg-muted/50 hover:text-foreground data-[state=active]:bg-muted/50 data-[state=active]:text-foreground data-[state=active]:shadow-none";

function ProjectTabLabel({ children }: { children: string }) {
  return (
    <span className="grid">
      <span
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 font-semibold"
      >
        {children}
      </span>
      <span className="col-start-1 row-start-1">{children}</span>
    </span>
  );
}

export function ProjectTabsList({ prsActive }: { prsActive?: boolean }) {
  return (
    <TabsList className="h-full min-w-0 max-w-full flex-none justify-start gap-1 overflow-x-auto bg-transparent p-0 scrollbar-none">
      <TabsTrigger
        aria-label="Overview"
        className={PROJECT_OVERVIEW_TAB_CLASS}
        title="README"
        value="overview"
      >
        <BookOpen className="h-full w-full" strokeWidth={2} />
      </TabsTrigger>
      <TabsTrigger className={PROJECT_TAB_TRIGGER_CLASS} value="files">
        <ProjectTabLabel>Files</ProjectTabLabel>
      </TabsTrigger>
      <TabsTrigger className={PROJECT_TAB_TRIGGER_CLASS} value="activity">
        <ProjectTabLabel>Commits</ProjectTabLabel>
      </TabsTrigger>
      <TabsTrigger className={PROJECT_TAB_TRIGGER_CLASS} value="issues">
        <ProjectTabLabel>Tasks</ProjectTabLabel>
      </TabsTrigger>
      <TabsTrigger
        aria-current={prsActive ? "page" : undefined}
        className={cn(
          PROJECT_TAB_TRIGGER_CLASS,
          prsActive && PROJECT_TAB_SELECTED_CLASS,
        )}
        value="prs"
      >
        <ProjectTabLabel>Review</ProjectTabLabel>
      </TabsTrigger>
      <TabsTrigger className={PROJECT_TAB_TRIGGER_CLASS} value="channels">
        <ProjectTabLabel>Channels</ProjectTabLabel>
      </TabsTrigger>
      <TabsTrigger className={PROJECT_TAB_TRIGGER_CLASS} value="channels">
        <ProjectTabLabel>Channels</ProjectTabLabel>
      </TabsTrigger>
      <TabsTrigger className={PROJECT_TAB_TRIGGER_CLASS} value="contributors">
        <ProjectTabLabel>Contributors</ProjectTabLabel>
      </TabsTrigger>
    </TabsList>
  );
}

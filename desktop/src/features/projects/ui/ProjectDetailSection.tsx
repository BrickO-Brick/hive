import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";

/**
 * Expand/collapse block for work-item detail (description, files, activity).
 * The chevron sits immediately after the title. It points down when open
 * and right when collapsed.
 */
export function ProjectDetailSection({
  children,
  count,
  defaultOpen = true,
  onOpenChange,
  open: openProp,
  testId,
  title,
}: {
  children: React.ReactNode;
  count?: number;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  testId?: string;
  title: string;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <section
      data-open={open ? "true" : "false"}
      data-testid={testId ?? "project-detail-section"}
    >
      <button
        aria-expanded={open}
        className="flex min-h-9 w-full min-w-0 items-center gap-2 px-4 py-1.5 text-left text-base font-normal leading-5 text-foreground transition-colors hover:bg-muted/20"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{title}</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
          {open && count != null ? (
            <span className="shrink-0 font-medium text-muted-foreground">
              {count}
            </span>
          ) : null}
        </span>
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </section>
  );
}

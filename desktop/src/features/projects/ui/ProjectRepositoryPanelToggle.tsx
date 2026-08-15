import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { DrawerPanelIcon } from "@/shared/ui/DrawerPanelIcon";

export function ProjectRepositoryPanelToggle({
  className,
  expanded = false,
  onClick,
}: {
  className?: string;
  expanded?: boolean;
  onClick: () => void;
}) {
  const action = expanded ? "Collapse" : "Expand";

  return (
    <Button
      aria-label={`${action} repository panel`}
      className={cn("h-7 w-7", className)}
      data-testid={`project-repository-actions-${expanded ? "collapse" : "expand"}`}
      onClick={onClick}
      size="icon"
      title={`${action} repository panel`}
      type="button"
      variant="ghost"
    >
      <DrawerPanelIcon side={expanded ? "right" : "left"} />
    </Button>
  );
}

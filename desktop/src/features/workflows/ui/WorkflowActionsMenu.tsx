import {
  Copy,
  MoreHorizontal,
  Pencil,
  Play,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Switch } from "@/shared/ui/switch";

type WorkflowActionsMenuProps = {
  isEnabled: boolean;
  isTogglingEnabled?: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onTrigger: () => void;
};

export function WorkflowActionsMenu({
  isEnabled,
  isTogglingEnabled = false,
  onDelete,
  onDuplicate,
  onEdit,
  onToggleEnabled,
  onTrigger,
}: WorkflowActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Workflow actions"
          className="h-8 w-8 text-muted-foreground hover:bg-background/80 hover:text-foreground data-[state=open]:bg-background/80 data-[state=open]:text-foreground"
          size="icon"
          type="button"
          variant="ghost"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onTrigger}>
          <Play className="mr-2 h-4 w-4" />
          Trigger
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="mr-2 h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy className="mr-2 h-4 w-4" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          checked={isEnabled}
          className="gap-2 pl-2 [&>span:first-child]:hidden"
          disabled={isTogglingEnabled}
          onCheckedChange={(checked) => {
            if (checked !== isEnabled) onToggleEnabled();
          }}
          onSelect={(event) => event.preventDefault()}
        >
          {isEnabled ? (
            <Power className="mr-2 h-4 w-4 shrink-0" />
          ) : (
            <PowerOff className="mr-2 h-4 w-4 shrink-0" />
          )}
          <span>Enable</span>
          <Switch
            aria-hidden="true"
            checked={isEnabled}
            className="pointer-events-none ml-auto"
            tabIndex={-1}
          />
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={onDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

export function CollectionIconDialog({
  icon,
  isSaving,
  onOpenChange,
  onSave,
  open,
}: {
  icon: string | null;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (icon: string | null) => Promise<void>;
  open: boolean;
}) {
  const [value, setValue] = React.useState(icon ?? "");
  React.useEffect(() => {
    if (open) setValue(icon ?? "");
  }, [icon, open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="collection-icon-dialog">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              try {
                await onSave(value.trim() || null);
                onOpenChange(false);
              } catch {
                // The caller reports the scoped error and the dialog stays open.
              }
            })();
          }}
        >
          <DialogHeader>
            <DialogTitle>Collection icon</DialogTitle>
            <DialogDescription>
              Choose a short emoji or symbol, or leave this blank for the
              default folder glyph.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Collection emoji"
            autoFocus
            maxLength={32}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Emoji or symbol"
            value={value}
          />
          <DialogFooter>
            <Button disabled={isSaving} type="submit">
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

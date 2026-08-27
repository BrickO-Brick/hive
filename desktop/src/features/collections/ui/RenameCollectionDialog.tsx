import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

export function RenameCollectionDialog({
  isSaving,
  name,
  onOpenChange,
  onSave,
  open,
}: {
  isSaving: boolean;
  name: string;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string) => Promise<void>;
  open: boolean;
}) {
  const [value, setValue] = React.useState(name);
  React.useEffect(() => {
    if (open) setValue(name);
  }, [name, open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="rename-collection-dialog">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            void (async () => {
              try {
                await onSave(trimmed);
                onOpenChange(false);
              } catch {
                // The caller reports the scoped error and the dialog stays open.
              }
            })();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename Collection</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Collection name"
            autoFocus
            maxLength={120}
            onChange={(event) => setValue(event.target.value)}
            value={value}
          />
          <DialogFooter>
            <Button
              disabled={isSaving || !value.trim() || value.trim() === name}
              type="submit"
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

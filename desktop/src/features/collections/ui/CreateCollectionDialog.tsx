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

type CreateCollectionDialogProps = {
  isCreating: boolean;
  onCreate: (name: string, icon: string | null) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export function CreateCollectionDialog({
  isCreating,
  onCreate,
  onOpenChange,
  open,
}: CreateCollectionDialogProps) {
  const [name, setName] = React.useState("");
  const [icon, setIcon] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setName("");
      setIcon("");
    }
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await onCreate(trimmed, icon.trim() || null);
      onOpenChange(false);
    } catch {
      // The owning surface reports the error and keeps the dialog open.
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="create-collection-dialog">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create collection</DialogTitle>
            <DialogDescription>
              Group related work and give people and agents a shared context.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Collection emoji"
            maxLength={32}
            onChange={(event) => setIcon(event.target.value)}
            placeholder="Emoji (optional)"
            value={icon}
          />
          <Input
            aria-label="Collection name"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            placeholder="Collection name"
            value={name}
          />
          <DialogFooter>
            <Button disabled={!name.trim() || isCreating} type="submit">
              {isCreating ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

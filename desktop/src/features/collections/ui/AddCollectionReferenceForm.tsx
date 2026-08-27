import { Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  type AddableCollectionReferenceType,
  parseCollectionReferenceInput,
} from "../referenceInput";
import type { CollectionReference } from "../types";

const TYPE_LABELS: Record<AddableCollectionReferenceType, string> = {
  external: "External link",
  repository: "Repository",
  task: "Repository task",
  note: "Note",
};

export function AddCollectionReferenceForm({
  isAdding,
  onAdd,
}: {
  isAdding: boolean;
  onAdd: (
    reference: CollectionReference,
    label: string | null,
  ) => Promise<void>;
}) {
  const [type, setType] =
    React.useState<AddableCollectionReferenceType>("external");
  const [coordinate, setCoordinate] = React.useState("");
  const [eventId, setEventId] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [label, setLabel] = React.useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = parseCollectionReferenceInput({
      coordinate,
      eventId,
      type,
      url,
    });
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    try {
      await onAdd(result.reference, label.trim() || null);
    } catch {
      return;
    }
    setCoordinate("");
    setEventId("");
    setUrl("");
    setLabel("");
  };

  return (
    <form
      className="mb-5 grid gap-3 rounded-xl border bg-card p-4"
      onSubmit={(event) => void submit(event)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label
          className="grid gap-1 text-sm"
          htmlFor="collection-reference-type"
        >
          <span className="font-medium">Reference type</span>
          <select
            aria-label="Reference type"
            className="h-9 rounded-lg border border-input/40 bg-background px-3 text-sm"
            id="collection-reference-type"
            onChange={(event) =>
              setType(event.target.value as AddableCollectionReferenceType)
            }
            value={type}
          >
            {(Object.keys(TYPE_LABELS) as AddableCollectionReferenceType[]).map(
              (value) => (
                <option key={value} value={value}>
                  {TYPE_LABELS[value]}
                </option>
              ),
            )}
          </select>
        </label>
        <label
          className="grid gap-1 text-sm"
          htmlFor="collection-reference-label"
        >
          <span className="font-medium">Label</span>
          <Input
            aria-label="Reference label"
            id="collection-reference-label"
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Optional"
            value={label}
          />
        </label>
      </div>

      {type === "external" ? (
        <Input
          aria-label="External URL"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…"
          type="url"
          value={url}
        />
      ) : (
        <Input
          aria-label={
            type === "note" ? "Note coordinate" : "Repository coordinate"
          }
          onChange={(event) => setCoordinate(event.target.value)}
          placeholder={
            type === "note"
              ? "30023:owner-pubkey:identifier"
              : "30617:owner-pubkey:repository"
          }
          value={coordinate}
        />
      )}
      {type === "task" ? (
        <Input
          aria-label="Task event ID"
          onChange={(event) => setEventId(event.target.value)}
          placeholder="64-character event ID"
          value={eventId}
        />
      ) : null}

      <Button className="justify-self-start" disabled={isAdding} type="submit">
        <Plus className="h-4 w-4" />
        Add {TYPE_LABELS[type].toLocaleLowerCase()}
      </Button>
    </form>
  );
}

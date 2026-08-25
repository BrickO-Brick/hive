import * as React from "react";

import {
  createRelaySkill,
  type RelaySkillCover,
  type ResolvedRelaySkill,
  updateRelaySkill,
} from "@/shared/api/tauriPersonas";
import { cn } from "@/shared/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { relayInstructionNameFromTitle } from "../lib/relayInstructionName";
import {
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
} from "./agentConfigOptions";

type RelaySkillEditorProps = {
  detail: ResolvedRelaySkill | null;
  embedded?: boolean;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPublished: (skill: RelaySkillCover) => void;
  registerCloseRequest: (request: (() => void) | null) => void;
};

const EMPTY_DRAFT = { title: "", summary: "", instructions: "" };

export function RelaySkillEditor({
  detail,
  embedded = false,
  onClose,
  onDirtyChange,
  onPublished,
  registerCloseRequest,
}: RelaySkillEditorProps) {
  const seed = React.useMemo(
    () =>
      detail
        ? {
            title: detail.title,
            summary: detail.summary ?? "",
            instructions: detail.content,
          }
        : EMPTY_DRAFT,
    [detail],
  );
  const [draft, setDraft] = React.useState(seed);
  const [publishState, setPublishState] = React.useState<
    "idle" | "publishing" | "error"
  >("idle");
  const [publishError, setPublishError] = React.useState("");
  const [discardConfirmationOpen, setDiscardConfirmationOpen] =
    React.useState(false);
  const dirty =
    draft.title !== seed.title ||
    draft.summary !== seed.summary ||
    draft.instructions !== seed.instructions;

  const requestClose = React.useCallback(() => {
    if (publishState === "publishing") return;
    if (dirty) {
      setDiscardConfirmationOpen(true);
      return;
    }
    onClose();
  }, [dirty, onClose, publishState]);

  React.useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  React.useEffect(() => {
    registerCloseRequest(requestClose);
    return () => registerCloseRequest(null);
  }, [registerCloseRequest, requestClose]);

  function updateDraft(field: keyof typeof draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setPublishError("");
    setPublishState("idle");
  }

  async function publishSkill(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPublishState("publishing");
    setPublishError("");
    try {
      const skill = detail
        ? await updateRelaySkill({
            ...draft,
            coordinate: detail.coordinate,
            expectedEventId: detail.eventId,
          })
        : await createRelaySkill({
            ...draft,
            name: relayInstructionNameFromTitle(draft.title),
          });
      onPublished(skill);
    } catch (error) {
      setPublishError(
        error instanceof Error
          ? error.message
          : detail
            ? "This instruction couldn’t be updated."
            : "This instruction couldn’t be published.",
      );
      setPublishState("error");
    }
  }

  const footer = (
    <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs leading-5 text-muted-foreground">
        Anyone in your community can read this.
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          disabled={publishState === "publishing"}
          onClick={requestClose}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          disabled={
            publishState === "publishing" ||
            !draft.title.trim() ||
            (!detail && !relayInstructionNameFromTitle(draft.title)) ||
            !draft.summary.trim() ||
            !draft.instructions.trim()
          }
          form="relay-skill-editor-form"
          type="submit"
        >
          {publishState === "publishing"
            ? detail
              ? "Saving…"
              : "Publishing…"
            : detail
              ? "Save changes"
              : "Publish"}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <ChooserDialogContent
        aria-label={
          detail ? "Edit shared instruction" : "Create shared instruction"
        }
        className={cn(
          "max-w-xl border-0",
          embedded &&
            "h-full max-h-none w-full max-w-none rounded-none shadow-none",
        )}
        contentClassName="pt-3"
        data-testid="relay-skill-editor"
        description={
          detail
            ? "Update the reusable guidance agents apply to relevant tasks."
            : "Add reusable guidance agents can apply to relevant tasks."
        }
        footer={footer}
        headerClassName="pb-2"
        headerSubtitle={
          detail
            ? "Update the reusable guidance agents apply to relevant tasks."
            : "Add reusable guidance agents can apply to relevant tasks."
        }
        scrollAreaTestId="relay-skill-editor-scroll-area"
        showCloseButton={!embedded}
        title={detail ? "Edit shared instruction" : "Create shared instruction"}
      >
        <form
          className="space-y-4"
          id="relay-skill-editor-form"
          onSubmit={publishSkill}
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="relay-skill-title">
              Title
            </label>
            <div
              className={cn(
                "flex min-h-11 items-center px-3",
                PERSONA_FIELD_SHELL_CLASS,
              )}
            >
              <Input
                autoFocus
                className={cn(
                  "h-8 px-0 py-0 leading-6",
                  PERSONA_FIELD_CONTROL_CLASS,
                )}
                id="relay-skill-title"
                maxLength={280}
                onChange={(event) => updateDraft("title", event.target.value)}
                placeholder="Engineering discipline"
                value={draft.title}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="relay-skill-summary"
            >
              When to use it
            </label>
            <div className={cn("overflow-hidden", PERSONA_FIELD_SHELL_CLASS)}>
              <Textarea
                className={cn(
                  "resize-none px-3 py-3 leading-5",
                  PERSONA_FIELD_CONTROL_CLASS,
                )}
                id="relay-skill-summary"
                maxLength={1024}
                onChange={(event) => updateDraft("summary", event.target.value)}
                placeholder="Raises implementation quality through validation, self-review, boundary checks, coverage, and second opinions. Use when coding, refactoring, reviewing changes, testing, or preparing work for completion."
                rows={3}
                value={draft.summary}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="relay-skill-instructions"
            >
              Instructions
            </label>
            <div className={cn("overflow-hidden", PERSONA_FIELD_SHELL_CLASS)}>
              <Textarea
                className={cn(
                  "min-h-40 resize-none px-3 py-3 font-mono text-sm leading-5",
                  PERSONA_FIELD_CONTROL_CLASS,
                )}
                id="relay-skill-instructions"
                maxLength={32768}
                onChange={(event) =>
                  updateDraft("instructions", event.target.value)
                }
                placeholder={
                  "Target a 9/10 or better standard for minimalness, elegance, and correctness.\n\nValidate work in the shape the task demands.\nSelf-review for accidental changes, debug code, weak boundaries, missing coverage, and convention violations…"
                }
                value={draft.instructions}
              />
            </div>
          </div>
          {publishError ? (
            <p className="text-sm text-destructive" role="alert">
              {publishError}
            </p>
          ) : null}
        </form>
      </ChooserDialogContent>

      <AlertDialog
        onOpenChange={setDiscardConfirmationOpen}
        open={discardConfirmationOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved instruction changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                Keep editing
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button onClick={onClose} type="button" variant="destructive">
                Discard changes
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

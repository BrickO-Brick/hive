import * as React from "react";
import { Check, Code, Pencil, X } from "lucide-react";
import { useBlocker } from "@tanstack/react-router";
import { isMap, parseDocument, stringify as yamlStringify } from "yaml";

import {
  useCreateWorkflowMutation,
  useUpdateWorkflowMutation,
} from "@/features/workflows/hooks";
import { generateBackupPassphrase } from "@/shared/api/tauriIdentity";
import type { Channel, Workflow } from "@/shared/api/types";
import { getRelayHttpUrl } from "@/shared/api/tauri";
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
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { ChannelCombobox } from "./ChannelCombobox";
import {
  WorkflowFormBuilder,
  type WorkflowEditorMode,
  type WorkflowFormBuilderHandle,
} from "./WorkflowFormBuilder";
import { WorkflowWebhookSecretDialog } from "./WorkflowWebhookSecretDialog";
import type { WorkflowEditorPane } from "./workflowEditorPane";
import {
  DEFAULT_FORM_STATE,
  formStateToYaml,
  yamlToFormState,
} from "./workflowFormTypes";

type DialogMode = "create" | "edit" | "duplicate";

type WorkflowDialogProps = {
  channels: Channel[];
  mode: DialogMode;
  onEditorPaneChange: (pane: WorkflowEditorPane) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pane: WorkflowEditorPane;
  workflow?: Workflow | null;
};

function getInitialYaml(
  mode: DialogMode,
  workflow: Workflow | null | undefined,
): string {
  if (!workflow) return "";
  const def = { ...workflow.definition };
  if (mode === "duplicate") {
    def.name = `${def.name ?? workflow.name} (copy)`;
  }
  return yamlStringify(def);
}

function getInitialEditorMode(yaml: string): WorkflowEditorMode {
  if (!yaml) return "form";
  return yamlToFormState(yaml).ok ? "form" : "yaml";
}

const TITLES: Record<DialogMode, string> = {
  create: "Create workflow",
  edit: "Edit workflow",
  duplicate: "Duplicate workflow",
};

const SUBMIT_LABELS: Record<DialogMode, string> = {
  create: "Create workflow",
  edit: "Save changes",
  duplicate: "Create copy",
};

const PENDING_LABELS: Record<DialogMode, string> = {
  create: "Creating…",
  edit: "Saving…",
  duplicate: "Creating…",
};

function visibleWorkflowName(
  yaml: string,
  fallbackName: string | undefined,
): string {
  const parsed = yamlToFormState(yaml);
  if (parsed.ok && parsed.state.name.trim()) return parsed.state.name.trim();
  return fallbackName?.trim() ?? "";
}

function yamlWithWorkflowName(yaml: string, name: string): string | null {
  if (!yaml.trim()) {
    return formStateToYaml({ ...DEFAULT_FORM_STATE, name });
  }

  const document = parseDocument(yaml);
  if (document.errors.length > 0 || !isMap(document.contents)) return null;
  document.set("name", name);
  return document.toString();
}

function WorkflowNameEditor({
  disabled,
  generating,
  name,
  onCommit,
  onEditingChange,
}: {
  disabled: boolean;
  generating: boolean;
  name: string;
  onCommit: (name: string) => boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!editing) setDraft(name);
  }, [editing, name]);

  React.useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const changeEditing = React.useCallback(
    (nextEditing: boolean) => {
      setEditing(nextEditing);
      onEditingChange(nextEditing);
    },
    [onEditingChange],
  );

  const commit = React.useCallback(() => {
    const nextName = draft.trim();
    if (!nextName || !onCommit(nextName)) return;
    changeEditing(false);
  }, [changeEditing, draft, onCommit]);

  if (editing) {
    return (
      <div className="flex h-6 items-center gap-1.5">
        <Input
          aria-label="Workflow name"
          autoCapitalize="off"
          autoCorrect="off"
          className="h-6 w-72 px-2 font-mono text-sm"
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(name);
              changeEditing(false);
            }
          }}
          ref={inputRef}
          value={draft}
        />
        <Button
          aria-label="Save workflow name"
          className="text-muted-foreground"
          disabled={disabled || !draft.trim()}
          onClick={commit}
          size="icon-xs"
          title="Save workflow name"
          type="button"
          variant="ghost"
        >
          <Check />
        </Button>
      </div>
    );
  }

  return (
    <div className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 font-mono text-sm text-muted-foreground">
      <span className="min-w-0 truncate">
        {generating ? "Generating name…" : name || "Untitled workflow"}
      </span>
      <Button
        aria-label="Edit workflow name"
        className="text-muted-foreground [&_svg]:size-3"
        disabled={disabled || generating}
        onClick={() => changeEditing(true)}
        size="icon-xs"
        title="Edit workflow name"
        type="button"
        variant="ghost"
      >
        <Pencil />
      </Button>
    </div>
  );
}

export function WorkflowDialog({
  channels,
  mode,
  onEditorPaneChange,
  onOpenChange,
  open,
  pane,
  workflow,
}: WorkflowDialogProps) {
  const formBuilderRef = React.useRef<WorkflowFormBuilderHandle>(null);
  const channelId =
    mode === "edit" && workflow?.channelId ? workflow.channelId : "";

  const [selectedChannelId, setSelectedChannelId] = React.useState(channelId);
  const [yamlDefinition, setYamlDefinition] = React.useState(() =>
    getInitialYaml(mode, workflow),
  );
  const [editorMode, setEditorMode] = React.useState<WorkflowEditorMode>(() =>
    getInitialEditorMode(getInitialYaml(mode, workflow)),
  );
  const [editorParseError, setEditorParseError] = React.useState<string | null>(
    null,
  );
  const [workflowNameEditing, setWorkflowNameEditing] = React.useState(false);
  const [nameLeadingElement, setNameLeadingElement] =
    React.useState<HTMLDivElement | null>(null);
  const [savedWebhookInfo, setSavedWebhookInfo] = React.useState<{
    relayHttpUrl: string;
    webhookSecret: string;
    workflowId: string;
  } | null>(null);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] =
    React.useState(false);
  const [generatingName, setGeneratingName] = React.useState(false);
  const initialValuesRef = React.useRef({
    channelId,
    yaml: getInitialYaml(mode, workflow),
  });
  const yamlDefinitionRef = React.useRef(yamlDefinition);
  const allowNavigationRef = React.useRef(false);
  const proceedingNavigationRef = React.useRef(false);

  const createMutation = useCreateWorkflowMutation(selectedChannelId);
  const updateMutation = useUpdateWorkflowMutation(workflow?.id ?? "");
  const mutation = mode === "edit" ? updateMutation : createMutation;

  const selectedChannel =
    channels.find((c) => c.id === selectedChannelId) ?? null;
  const parsedDefinition = yamlDefinition.trim()
    ? yamlToFormState(yamlDefinition)
    : null;
  const isAddingFirstStep =
    mode === "create" &&
    editorMode === "form" &&
    (parsedDefinition === null ||
      (parsedDefinition.ok && parsedDefinition.state.steps.length === 0));

  const workflowChannelId = workflow?.channelId ?? null;
  const resetCreate = createMutation.reset;
  const resetUpdate = updateMutation.reset;

  // Re-initialize when dialog opens or workflow/mode changes
  React.useEffect(() => {
    let active = true;
    if (open) {
      const newChannelId =
        mode === "edit" && workflowChannelId ? workflowChannelId : "";
      setSelectedChannelId(newChannelId);
      const initialYaml = getInitialYaml(mode, workflow);
      initialValuesRef.current = {
        channelId: newChannelId,
        yaml: initialYaml,
      };
      yamlDefinitionRef.current = initialYaml;
      setYamlDefinition(initialYaml);
      setEditorMode(getInitialEditorMode(initialYaml));
      setEditorParseError(null);
      setWorkflowNameEditing(false);
      setSavedWebhookInfo(null);
      setDiscardConfirmationOpen(false);
      resetCreate();
      resetUpdate();

      if (mode === "create" && !workflow) {
        setGeneratingName(true);
        void generateBackupPassphrase({ words: 3, separator: "-" })
          .then((name) => {
            if (!active || yamlDefinitionRef.current.trim()) return;
            const generatedYaml = formStateToYaml({
              ...DEFAULT_FORM_STATE,
              name,
            });
            yamlDefinitionRef.current = generatedYaml;
            initialValuesRef.current = {
              ...initialValuesRef.current,
              yaml: generatedYaml,
            };
            setYamlDefinition(generatedYaml);
          })
          .catch(() => {
            // Leave the editable "Untitled workflow" fallback in place.
          })
          .finally(() => {
            if (active) setGeneratingName(false);
          });
      } else {
        setGeneratingName(false);
      }
    }

    return () => {
      active = false;
    };
  }, [open, mode, workflow, workflowChannelId, resetCreate, resetUpdate]);

  const closeDialog = React.useCallback(() => {
    resetCreate();
    resetUpdate();
    setDiscardConfirmationOpen(false);
    onOpenChange(false);
  }, [onOpenChange, resetCreate, resetUpdate]);

  const isDirty =
    yamlDefinition !== initialValuesRef.current.yaml ||
    selectedChannelId !== initialValuesRef.current.channelId;
  const navigationBlocker = useBlocker({
    enableBeforeUnload: isDirty,
    shouldBlockFn: ({ current, next }) => {
      const currentSearch = current.search as { view?: unknown };
      const nextSearch = next.search as { view?: unknown };
      const staysInEditor =
        current.pathname === next.pathname &&
        currentSearch.view === nextSearch.view;
      return isDirty && !allowNavigationRef.current && !staysInEditor;
    },
    withResolver: true,
  });

  React.useEffect(() => {
    if (navigationBlocker.status === "blocked") {
      setDiscardConfirmationOpen(true);
    }
  }, [navigationBlocker.status]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpenChange(true);
      } else if (isDirty) {
        setDiscardConfirmationOpen(true);
      } else {
        closeDialog();
      }
    },
    [closeDialog, isDirty, onOpenChange],
  );

  async function handleSubmit() {
    if (!selectedChannelId || !yamlDefinition.trim()) return;

    try {
      const saved = await mutation.mutateAsync(yamlDefinition);
      if (saved.webhookSecret) {
        const relayHttpUrl = await getRelayHttpUrl();
        setSavedWebhookInfo({
          relayHttpUrl,
          webhookSecret: saved.webhookSecret,
          workflowId: saved.workflow.id,
        });
      } else {
        allowNavigationRef.current = true;
        closeDialog();
      }
    } catch {
      // React Query stores the error; keep the dialog open.
    }
  }

  const handleEditorModeChange = React.useCallback(
    (nextMode: string) => {
      if (nextMode === editorMode) return;

      if (nextMode === "yaml") {
        setEditorParseError(null);
        setEditorMode("yaml");
        return;
      }

      if (!yamlDefinition.trim()) {
        setEditorParseError(null);
        setEditorMode("form");
        return;
      }

      const result = yamlToFormState(yamlDefinition);
      if (result.ok) {
        setEditorParseError(null);
        setEditorMode("form");
      } else {
        setEditorParseError(result.error);
      }
    },
    [editorMode, yamlDefinition],
  );

  const workflowName = visibleWorkflowName(yamlDefinition, workflow?.name);
  const canEditWorkflowName =
    !yamlDefinition.trim() || yamlToFormState(yamlDefinition).ok;
  const handleWorkflowNameCommit = React.useCallback(
    (name: string) => {
      const nextYaml = yamlWithWorkflowName(yamlDefinitionRef.current, name);
      if (nextYaml === null) return false;
      mutation.reset();
      yamlDefinitionRef.current = nextYaml;
      setYamlDefinition(nextYaml);
      return true;
    },
    [mutation.reset],
  );

  const showChannelSelector = mode !== "edit";

  return (
    <>
      <Dialog
        onOpenChange={handleOpenChange}
        open={open && savedWebhookInfo === null}
      >
        <DialogContent
          className="flex h-[88vh] max-h-[88vh] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0"
          showCloseButton={false}
        >
          <DialogHeader className="flex flex-shrink-0 flex-row items-center justify-between gap-6 space-y-0 px-6 pt-3 pb-2 text-left">
            <div className="space-y-0">
              <DialogTitle className="text-lg leading-tight">
                {TITLES[mode]}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {mode === "edit"
                  ? "Update when this workflow runs and what it does."
                  : mode === "duplicate"
                    ? "Copy this workflow and adjust its details."
                    : "Automate actions when something happens in a channel."}
              </DialogDescription>
              <div className="flex items-center gap-2">
                <WorkflowNameEditor
                  disabled={mutation.isPending || !canEditWorkflowName}
                  generating={generatingName}
                  name={workflowName}
                  onCommit={handleWorkflowNameCommit}
                  onEditingChange={setWorkflowNameEditing}
                />
                <div
                  className={
                    editorMode === "form" && !workflowNameEditing
                      ? "flex items-center"
                      : "hidden"
                  }
                  ref={setNameLeadingElement}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <DialogClose asChild>
                <Button
                  aria-label="Close"
                  className="h-8 w-8 text-muted-foreground"
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X className="h-4 w-4" />
                </Button>
              </DialogClose>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1">
            <WorkflowFormBuilder
              channels={channels}
              disabled={mutation.isPending}
              mode={editorMode}
              nameLeadingContainer={nameLeadingElement}
              onChange={(yaml) => {
                mutation.reset();
                yamlDefinitionRef.current = yaml;
                setYamlDefinition(yaml);
              }}
              onSelectedNodeChange={onEditorPaneChange}
              parseError={editorParseError}
              ref={formBuilderRef}
              scopeField={
                showChannelSelector ? (
                  <div className="space-y-1">
                    <ChannelCombobox
                      channels={channels}
                      defaultOpen={mode === "create" && editorMode === "form"}
                      disabled={mutation.isPending}
                      id="wf-channel-select"
                      onChange={(value) => {
                        mutation.reset();
                        setSelectedChannelId(value);
                        if (value) onEditorPaneChange({ type: "trigger" });
                      }}
                      required
                      variant={editorMode === "yaml" ? "field" : "header"}
                      value={selectedChannelId}
                    />
                    {channels.length === 0 ? (
                      <p className="text-center text-xs text-muted-foreground">
                        Join or create a channel before adding a workflow.
                      </p>
                    ) : null}
                  </div>
                ) : mode === "edit" && selectedChannel ? (
                  <ChannelCombobox
                    channels={channels}
                    id="wf-channel-select"
                    onChange={setSelectedChannelId}
                    readOnly
                    variant={editorMode === "yaml" ? "field" : "header"}
                    value={selectedChannel.id}
                  />
                ) : null
              }
              selectedNode={pane}
              workflowChannelId={selectedChannelId || null}
              yaml={yamlDefinition}
            />
          </div>

          {mutation.error instanceof Error ? (
            <p className="mx-6 mb-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {mutation.error.message}
            </p>
          ) : null}

          <div className="flex flex-shrink-0 items-center justify-between gap-4 px-6 pt-2 pb-4">
            <Tabs onValueChange={handleEditorModeChange} value={editorMode}>
              <TabsList aria-label="Workflow editor mode" className="h-8 p-0.5">
                <TabsTrigger
                  className="h-7 px-3 text-xs"
                  disabled={mutation.isPending}
                  value="form"
                >
                  Form
                </TabsTrigger>
                <TabsTrigger
                  className="h-7 gap-1.5 px-3 text-xs"
                  disabled={mutation.isPending}
                  value="yaml"
                >
                  <Code className="h-3.5 w-3.5" />
                  YAML
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => handleOpenChange(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              {isAddingFirstStep ? (
                <Button
                  aria-label="Add first step"
                  data-testid="workflow-dialog-primary-action"
                  disabled={!selectedChannelId || mutation.isPending}
                  onClick={() => formBuilderRef.current?.addFirstStep()}
                  type="button"
                >
                  Add step
                </Button>
              ) : (
                <Button
                  data-testid="workflow-dialog-primary-action"
                  disabled={
                    !selectedChannelId ||
                    !yamlDefinition.trim() ||
                    mutation.isPending
                  }
                  onClick={handleSubmit}
                  type="button"
                >
                  {mutation.isPending
                    ? PENDING_LABELS[mode]
                    : SUBMIT_LABELS[mode]}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(nextOpen) => {
          setDiscardConfirmationOpen(nextOpen);
          if (
            !nextOpen &&
            navigationBlocker.status === "blocked" &&
            !proceedingNavigationRef.current
          ) {
            navigationBlocker.reset();
          }
        }}
        open={discardConfirmationOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved workflow changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                Keep editing
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                onClick={() => {
                  setDiscardConfirmationOpen(false);
                  if (navigationBlocker.status === "blocked") {
                    proceedingNavigationRef.current = true;
                    navigationBlocker.proceed();
                    return;
                  }
                  allowNavigationRef.current = true;
                  closeDialog();
                }}
                type="button"
                variant="destructive"
              >
                Discard changes
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {savedWebhookInfo ? (
        <WorkflowWebhookSecretDialog
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              allowNavigationRef.current = true;
              closeDialog();
            }
          }}
          open
          relayHttpUrl={savedWebhookInfo.relayHttpUrl}
          webhookSecret={savedWebhookInfo.webhookSecret}
          workflowId={savedWebhookInfo.workflowId}
        />
      ) : null}
    </>
  );
}

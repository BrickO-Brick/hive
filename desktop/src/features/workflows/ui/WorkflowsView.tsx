import { Plus, RefreshCw, Zap } from "lucide-react";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  allWorkflowsQueryKey,
  workflowListFocusRefetchPolicy,
} from "@/features/workflows/hooks";
import { WorkflowCard } from "@/features/workflows/ui/WorkflowCard";
import { WorkflowDeleteDialog } from "@/features/workflows/ui/WorkflowDeleteDialog";
import { WorkflowDetailPanel } from "@/features/workflows/ui/WorkflowDetailPanel";
import { WorkflowDialog } from "@/features/workflows/ui/WorkflowDialog";
import type { Channel, Workflow } from "@/shared/api/types";
import {
  deleteWorkflow,
  getChannelsWorkflows,
  triggerWorkflow,
} from "@/shared/api/tauriWorkflows";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";

type WorkflowsViewProps = {
  channels: Channel[];
  onCloseWorkflow: () => void;
  selectedWorkflowId: string | null;
};

type WorkflowWithChannel = {
  workflow: Workflow;
  channelName: string;
};

type DialogState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; workflow: Workflow }
  | { mode: "duplicate"; workflow: Workflow };

function WorkflowsListSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {["first", "second", "third", "fourth"].map((card) => (
        <div
          className="flex min-h-60 flex-col rounded-2xl border bg-card p-5"
          key={card}
        >
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-9 rounded-xl" />
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-9 w-9 rounded-xl" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
          <Skeleton className="mt-5 h-3 w-28" />
          <Skeleton className="mt-2 h-6 w-full" />
          <Skeleton className="mt-2 h-6 w-4/5" />
          <Skeleton className="mt-auto h-4 w-32" />
        </div>
      ))}
    </div>
  );
}

export function WorkflowsView({
  channels,
  onCloseWorkflow,
  selectedWorkflowId,
}: WorkflowsViewProps) {
  const [dialogState, setDialogState] = React.useState<DialogState>({
    mode: "closed",
  });
  const [deleteTarget, setDeleteTarget] = React.useState<Workflow | null>(null);
  const queryClient = useQueryClient();

  const memberChannels = channels.filter((c) => c.isMember);
  const channelIds = memberChannels.map((c) => c.id).sort();
  const channelIdKey = channelIds.join(",");

  const allWorkflowsQuery = useQuery({
    queryKey: allWorkflowsQueryKey(channelIdKey),
    queryFn: async () => {
      // Single batched relay query for all member channels, then group by the
      // channel_id each workflow carries — replaces the per-channel fanout.
      const channelNameById = new Map(
        memberChannels.map((channel) => [channel.id, channel.name]),
      );
      const workflows = await getChannelsWorkflows(channelIds);
      const results: WorkflowWithChannel[] = [];
      for (const workflow of workflows) {
        results.push({
          workflow,
          channelName: workflow.channelId
            ? (channelNameById.get(workflow.channelId) ?? "")
            : "",
        });
      }
      return results;
    },
    enabled: memberChannels.length > 0,
    ...workflowListFocusRefetchPolicy,
  });

  const allWorkflows = allWorkflowsQuery.data ?? [];

  const triggerMutation = useMutation({
    mutationFn: (workflowId: string) => triggerWorkflow(workflowId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "workflow-runs",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (workflowId: string) => deleteWorkflow(workflowId),
    onSuccess: (_data, workflowId) => {
      if (selectedWorkflowId === workflowId) {
        onCloseWorkflow();
      }
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "workflows" ||
          query.queryKey[0] === "workflows-all",
      });
    },
  });

  const triggerOne = triggerMutation.mutate;
  const handleTrigger = React.useCallback(
    (workflowId: string) => triggerOne(workflowId),
    [triggerOne],
  );

  const handleDelete = React.useCallback(
    (workflow: Workflow) => setDeleteTarget(workflow),
    [],
  );

  const deleteOne = deleteMutation.mutate;
  const handleConfirmDelete = React.useCallback(
    (workflow: Workflow) => {
      deleteOne(workflow.id);
      setDeleteTarget(null);
    },
    [deleteOne],
  );

  const handleEdit = React.useCallback(
    (workflow: Workflow) => setDialogState({ mode: "edit", workflow }),
    [],
  );

  const handleDuplicate = React.useCallback(
    (workflow: Workflow) => setDialogState({ mode: "duplicate", workflow }),
    [],
  );

  const handleDialogOpenChange = React.useCallback((open: boolean) => {
    if (!open) {
      setDialogState({ mode: "closed" });
    }
  }, []);

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden"
      data-testid="workflows-view"
    >
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-5 pt-5"
        data-scroll-restoration-id="workflows-list"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">Workflows</h2>
              <Button
                aria-label="Refresh workflows"
                disabled={allWorkflowsQuery.isFetching}
                onClick={() => void allWorkflowsQuery.refetch()}
                size="icon"
                variant="ghost"
              >
                <RefreshCw
                  className={`h-4 w-4 ${allWorkflowsQuery.isFetching ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Automations that keep your community moving.
            </p>
          </div>
          <Button onClick={() => setDialogState({ mode: "create" })} size="sm">
            <Plus className="mr-1 h-4 w-4" />
            Create Workflow
          </Button>
        </div>

        {allWorkflowsQuery.isLoading ? (
          <WorkflowsListSkeleton />
        ) : allWorkflowsQuery.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <p className="text-sm text-red-400">Failed to load workflows</p>
            <Button
              onClick={() => void allWorkflowsQuery.refetch()}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : allWorkflows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Zap className="h-10 w-10 opacity-30" />
            <p className="text-sm">No workflows yet</p>
            <Button
              onClick={() => setDialogState({ mode: "create" })}
              size="sm"
              variant="outline"
            >
              <Plus className="mr-1 h-4 w-4" />
              Create your first workflow
            </Button>
          </div>
        ) : (
          <div
            className={
              selectedWorkflowId
                ? "grid grid-cols-1 gap-3 xl:grid-cols-2"
                : "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
            }
          >
            {allWorkflows.map(({ workflow, channelName }) => (
              <WorkflowCard
                channelName={channelName}
                isActive={selectedWorkflowId === workflow.id}
                key={workflow.id}
                onDelete={handleDelete}
                onDuplicate={handleDuplicate}
                onEdit={handleEdit}
                onTrigger={handleTrigger}
                workflow={workflow}
              />
            ))}
          </div>
        )}
      </div>

      {selectedWorkflowId ? (
        <div className="w-[400px] shrink-0">
          <WorkflowDetailPanel
            key={selectedWorkflowId}
            onClose={onCloseWorkflow}
            onEdit={handleEdit}
            workflowId={selectedWorkflowId}
          />
        </div>
      ) : null}

      <WorkflowDialog
        channels={memberChannels}
        mode={dialogState.mode === "closed" ? "create" : dialogState.mode}
        onOpenChange={handleDialogOpenChange}
        open={dialogState.mode !== "closed"}
        workflow={
          dialogState.mode === "edit" || dialogState.mode === "duplicate"
            ? dialogState.workflow
            : null
        }
      />

      <WorkflowDeleteDialog
        onConfirm={handleConfirmDelete}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        open={deleteTarget !== null}
        workflow={deleteTarget}
      />
    </div>
  );
}

import { useAgentManagement } from "@/features/agents/useAgentManagement";
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
import { AgentCardDialogs } from "./AgentCardViewerDialog";
import { AgentDialog } from "./AgentDialog";

/** Global review surfaces opened by owned agents through the Buzz harness. */
export function AgentManagementDialogs() {
  const management = useAgentManagement();

  return (
    <>
      {management.request?.action === "create" ? (
        <AgentDialog
          definitionError={
            management.error ? new Error(management.error) : null
          }
          initialValues={management.createInitialValues}
          isDefinitionPending={management.isPending}
          mode="definition"
          onOpenChange={(open) => {
            if (!open) management.dismiss();
          }}
          onSubmitDefinition={management.submitCreate}
          runtimes={management.runtimes}
          runtimeCatalogStatus={management.runtimeCatalogStatus}
        />
      ) : null}
      {management.request?.action === "update" ? (
        <AgentDialog
          description=""
          error={management.editError ? new Error(management.editError) : null}
          initialValues={management.editInitialValues}
          isPending={management.isPending}
          mode="definition-edit"
          onOpenChange={(open) => {
            if (!open) management.dismiss();
          }}
          onSubmit={management.submitUpdate}
          open
          runtimes={management.runtimes}
          runtimeCatalogStatus={management.runtimeCatalogStatus}
          submitLabel="Save changes"
          title="Edit agent"
        />
      ) : null}
      {management.request?.action === "delete" ? (
        <AlertDialog
          onOpenChange={(open) => {
            if (!open) management.dismiss();
          }}
          open
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete agent?</AlertDialogTitle>
              <AlertDialogDescription>
                {management.targetAgent
                  ? `One of your agents asked to delete "${management.targetAgent.name}". This stops it, removes it from its channels, and deletes its record.`
                  : "One of your agents asked to delete an agent."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {management.deleteError ? (
              <p className="text-sm text-destructive">
                {management.deleteError}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button type="button" variant="outline">
                  Keep agent
                </Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button
                  disabled={!management.targetAgent || management.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    void management.confirmDelete();
                  }}
                  type="button"
                  variant="destructive"
                >
                  Delete
                </Button>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      <AgentCardDialogs />
    </>
  );
}

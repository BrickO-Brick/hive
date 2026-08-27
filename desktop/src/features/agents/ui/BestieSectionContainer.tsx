import * as React from "react";
import { toast } from "sonner";

import { useFeatureEnabled } from "@/shared/features";
import { BestieRemoveDialog } from "./BestieRemoveDialog";
import { BestieSection } from "./BestieSection";
import {
  BestieSetupDialog,
  type BestieSetupSubmission,
} from "./BestieSetupDialog";
import { useBestieRole } from "./useBestieRole";

/**
 * Feature-gated entry point for the Bestie role on the Agents page. Renders
 * nothing unless the build carries the capability and the user opted in, so no
 * query, listener, or side effect runs for anyone else.
 */
export function BestieSectionContainer() {
  const isEnabled = useFeatureEnabled("bestie");
  if (!isEnabled) return null;
  return <BestieSectionContent />;
}

function BestieSectionContent() {
  const role = useBestieRole();
  const [isSetupOpen, setIsSetupOpen] = React.useState(false);
  const [isManaging, setIsManaging] = React.useState(false);
  const [isRemoveOpen, setIsRemoveOpen] = React.useState(false);

  async function handleSubmit(submission: BestieSetupSubmission) {
    await role.assign(submission);
    toast.success(
      isManaging
        ? "Updated your bestie"
        : `${submission.agentName} is your bestie`,
    );
  }

  return (
    <>
      <BestieSection
        agent={role.agent}
        capabilities={role.assignment?.capabilities ?? null}
        isMessagePending={role.isMessagePending}
        onManage={() => {
          setIsManaging(true);
          setIsSetupOpen(true);
        }}
        onMessage={() => {
          void role.message().catch((cause: unknown) => {
            toast.error(
              cause instanceof Error
                ? cause.message
                : "Couldn’t open that conversation.",
            );
          });
        }}
        onRemove={() => setIsRemoveOpen(true)}
        onSetUp={() => {
          setIsManaging(false);
          setIsSetupOpen(true);
        }}
      />

      {role.agent ? (
        <BestieRemoveDialog
          agent={role.agent}
          isPending={role.isRemovePending}
          onDeleteAgent={() => {
            const name = role.agent?.name ?? "That agent";
            void role
              .unassignAndDelete()
              .then(() => {
                setIsRemoveOpen(false);
                toast.success(`Deleted ${name}`);
              })
              .catch((cause: unknown) => {
                toast.error(
                  cause instanceof Error
                    ? cause.message
                    : "Couldn’t delete that agent.",
                );
              });
          }}
          onKeepAgent={() => {
            const name = role.agent?.name ?? "That agent";
            role.unassign();
            setIsRemoveOpen(false);
            toast.success(`${name} is no longer your bestie`);
          }}
          onOpenChange={setIsRemoveOpen}
          open={isRemoveOpen}
        />
      ) : null}

      <BestieSetupDialog
        agents={role.agents}
        initial={
          isManaging && role.assignment
            ? {
                additionalInstructions: role.assignment.additionalInstructions,
                agentPubkey: role.assignment.agentPubkey,
                capabilities: role.assignment.capabilities,
              }
            : null
        }
        isLoadingAgents={role.isAgentsLoading}
        onOpenChange={setIsSetupOpen}
        onSubmit={handleSubmit}
        open={isSetupOpen}
        runtimes={role.runtimes}
        runtimesLoading={role.runtimesLoading}
      />
    </>
  );
}

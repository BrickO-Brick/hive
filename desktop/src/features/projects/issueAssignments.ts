import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { signProjectIssueAssignment } from "@/shared/api/projectGit";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import type { Repository as Project } from "./hooks";
import { ISSUE_ASSIGNMENT_LABEL, type ProjectIssue } from "./projectIssues.mjs";

// Issue assignments mirror PR review requests (pullRequestReviews.ts):
// labeled kind:1 comments whose `p` tags are the assignees. Parsing
// trusts assignments signed by the issue author or repo owner, plus
// self-assignments (the sole `p` tag is the signer). The `p` tags land
// the assignment in the assignee's mention feed (inbox).
async function assignProjectIssue({
  assignees,
  assigneeLabel,
  issue,
  project,
  signAsManagedOwner,
}: {
  assignees: string[];
  assigneeLabel: string;
  issue: ProjectIssue;
  project: Project;
  signAsManagedOwner: boolean;
}): Promise<void> {
  if (assignees.length === 0) {
    throw new Error("Select at least one assignee.");
  }
  const assigneePubkeys = [
    ...new Set(assignees.map((pubkey) => pubkey.toLowerCase())),
  ];
  if (signAsManagedOwner) {
    await signProjectIssueAssignment({
      targetOwner: project.owner,
      repoAddress: project.repoAddress,
      issueId: issue.id,
      assignees: assigneePubkeys,
      assigneeLabel,
    });
    return;
  }
  const event = await signRelayEvent({
    kind: KIND_TEXT_NOTE,
    content: `Assigned this issue to ${assigneeLabel}`,
    tags: [
      ["e", issue.id, "", "root"],
      ["a", project.repoAddress],
      ...assigneePubkeys.map((pubkey) => ["p", pubkey]),
      ["t", ISSUE_ASSIGNMENT_LABEL],
    ],
  });

  await relayClient.publishEvent(
    event,
    "Timed out assigning issue.",
    "Failed to assign issue.",
  );
}

export function useProjectIssueWriteInvalidation(
  project: Project | null | undefined,
) {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["project", project?.id ?? "none", "issues"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["projects", "work-items"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["projects", "activity-summaries"],
    });
  }, [project?.id, queryClient]);
}

export function useAssignProjectIssueMutation(
  project: Project | null | undefined,
) {
  const invalidate = useProjectIssueWriteInvalidation(project);

  return useMutation({
    mutationFn: ({
      assignees,
      assigneeLabel,
      issue,
      signAsManagedOwner,
    }: {
      assignees: string[];
      assigneeLabel: string;
      issue: ProjectIssue;
      signAsManagedOwner: boolean;
    }) => {
      if (!project) throw new Error("No project selected.");
      return assignProjectIssue({
        assignees,
        assigneeLabel,
        issue,
        project,
        signAsManagedOwner,
      });
    },
    onSuccess: invalidate,
  });
}

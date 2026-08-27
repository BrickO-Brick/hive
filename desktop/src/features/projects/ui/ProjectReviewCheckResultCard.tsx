import { Check, CheckCircle2, CircleAlert, FileDiff } from "lucide-react";
import * as React from "react";

import type {
  ProjectReviewCheckDiffProposal,
  ProjectReviewCheckResult,
} from "@/features/projects/lib/projectReviewChecks.mjs";
import { Button } from "@/shared/ui/button";

const DiffMessage = React.lazy(
  () => import("@/features/messages/ui/DiffMessage"),
);
const DiffMessageExpanded = React.lazy(
  () => import("@/features/messages/ui/DiffMessageExpanded"),
);

function ReviewCheckDiffProposal({
  accepted,
  canAccept,
  onAccept,
  proposal,
}: {
  accepted: boolean;
  canAccept: boolean;
  onAccept: () => void;
  proposal: ProjectReviewCheckDiffProposal;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const acceptEnabled = canAccept && !proposal.truncated;

  return (
    <div
      className="space-y-3 border-t border-border/55 px-4 py-4"
      data-testid="project-review-check-diff-proposal"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileDiff className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h6 className="text-xs font-semibold text-foreground">
              Proposed code changes
            </h6>
            <p className="truncate text-2xs text-muted-foreground">
              Native Buzz diff · {proposal.commitSha.slice(0, 7)}
            </p>
          </div>
        </div>
        <Button
          disabled={accepted || !acceptEnabled}
          onClick={onAccept}
          size="sm"
          type="button"
          variant={accepted ? "secondary" : "default"}
        >
          {accepted ? <Check /> : null}
          {accepted ? "Accepted" : "Accept changes"}
        </Button>
      </div>
      <React.Suspense
        fallback={
          <div className="p-3 text-xs text-muted-foreground">
            Loading proposed changes…
          </div>
        }
      >
        <DiffMessage
          commitSha={proposal.commitSha}
          content={proposal.content}
          description={proposal.description ?? undefined}
          filePath={proposal.filePath ?? undefined}
          onExpand={() => setExpanded(true)}
          repoUrl={proposal.repoUrl}
          truncated={proposal.truncated}
        />
      </React.Suspense>
      <p className="text-2xs text-muted-foreground">
        {accepted
          ? "Accepted for this prototype. No repository files or review state were changed."
          : proposal.truncated
            ? "This proposal is truncated and cannot be accepted. No code was changed."
            : acceptEnabled
              ? "Preview only. Accepting records your choice in this dev build and does not change code."
              : "This proposal is outdated. Run the check again before accepting it. No code was changed."}
      </p>
      {expanded ? (
        <React.Suspense fallback={null}>
          <DiffMessageExpanded
            content={proposal.content}
            filePath={proposal.filePath ?? undefined}
            onClose={() => setExpanded(false)}
          />
        </React.Suspense>
      ) : null}
    </div>
  );
}

export function ProjectReviewCheckResultCard({
  acceptedProposalEventId,
  canAcceptProposal,
  onAcceptProposal,
  proposal,
  result,
}: {
  acceptedProposalEventId?: string;
  canAcceptProposal: boolean;
  onAcceptProposal: (eventId: string) => void;
  proposal?: ProjectReviewCheckDiffProposal;
  result: ProjectReviewCheckResult;
}) {
  const isApproved = result.conclusion === "approved";
  const findingCount = result.findings.length;
  const title = isApproved
    ? "Approved"
    : findingCount === 0
      ? "Fix recommended"
      : `${findingCount} ${findingCount === 1 ? "fix" : "fixes"} recommended`;

  return (
    <section
      className="overflow-hidden rounded-xl border border-border/70 bg-background/70"
      data-testid="project-review-check-result"
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/70">
          {isApproved ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : (
            <CircleAlert className="h-5 w-5 text-amber-500" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h5 className="text-sm font-semibold text-foreground">{title}</h5>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {result.summary}
          </p>
        </div>
      </div>
      {findingCount > 0 ? (
        <div className="divide-y divide-border/55 border-t border-border/55">
          {result.findings.map((finding) => (
            <article
              className="px-4 py-3"
              data-testid="project-review-check-finding"
              key={JSON.stringify(finding)}
            >
              <div className="flex items-start justify-between gap-4">
                <p className="min-w-0 flex-1 text-xs font-medium text-foreground">
                  {finding.title}
                </p>
                {finding.file ? (
                  <span
                    className="max-w-[45%] truncate font-mono text-2xs text-muted-foreground"
                    title={`${finding.file}${finding.line ? `:${finding.line}` : ""}`}
                  >
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </span>
                ) : null}
              </div>
              {finding.detail ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {finding.detail}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {proposal ? (
        <ReviewCheckDiffProposal
          accepted={acceptedProposalEventId === proposal.eventId}
          canAccept={canAcceptProposal}
          onAccept={() => onAcceptProposal(proposal.eventId)}
          proposal={proposal}
        />
      ) : null}
    </section>
  );
}

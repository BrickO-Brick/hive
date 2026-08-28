import { Check, ChevronRight, FileDiff, LoaderCircle, X } from "lucide-react";
import * as React from "react";

import {
  countDiffFileChanges,
  getDiffFilePath,
  getShortestUniquePathLabels,
  parseUnifiedDiff,
} from "@/features/messages/lib/parseDiff";
import { DiffViewer } from "@/features/messages/ui/DiffViewer";
import type {
  ProjectReviewCheckResolvedProposal,
  ProjectReviewCheckResult,
} from "@/features/projects/lib/projectReviewChecks.mjs";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";

function ProposalDiffFiles({
  files,
  parseError,
  proposal,
}: {
  files: ReturnType<typeof parseUnifiedDiff>["files"];
  parseError: boolean;
  proposal: ProjectReviewCheckResolvedProposal;
}) {
  if (parseError || files.length === 0) {
    const label = getShortestUniquePathLabels([
      proposal.filePath ?? "Proposed patch",
    ])[0];

    return (
      <details className="group overflow-hidden rounded-lg border border-border/60 bg-background/50">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <FileDiff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-foreground/85">
            {label}
          </span>
        </summary>
        <div className="overflow-auto border-t border-border/50 p-2">
          <DiffViewer
            content={proposal.content}
            fallbackFilePath={proposal.filePath ?? undefined}
          />
        </div>
      </details>
    );
  }

  const labels = getShortestUniquePathLabels(
    files.map((file) => getDiffFilePath(file, proposal.filePath ?? undefined)),
  );

  return (
    <div className="space-y-1.5">
      {files.map((file, index) => {
        const label = labels[index];
        const { additions, deletions } = countDiffFileChanges(file);
        const key = `${file.oldPath ?? ""}:${file.newPath ?? ""}:${index}`;

        return (
          <details
            className="group overflow-hidden rounded-lg border border-border/60 bg-background/50"
            data-testid="project-review-check-proposal-file"
            key={key}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">
                {label}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs font-semibold">
                <span className="text-status-added">+{additions}</span>
                <span className="text-status-deleted">-{deletions}</span>
              </span>
            </summary>
            <div className="max-h-[24rem] overflow-auto border-t border-border/50 p-2">
              <DiffViewer
                content={proposal.content}
                fallbackFilePath={proposal.filePath ?? undefined}
                fileIndex={index}
                hideFileHeader
              />
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ProposalOption({
  accepted,
  canAccept,
  index,
  onAccept,
  proposal,
}: {
  accepted: boolean;
  canAccept: boolean;
  index: number;
  onAccept: () => void;
  proposal: ProjectReviewCheckResolvedProposal;
}) {
  const acceptEnabled = canAccept && !proposal.truncated;
  const parsedDiff = React.useMemo(
    () => parseUnifiedDiff(proposal.content),
    [proposal.content],
  );
  const totals = parsedDiff.files.reduce(
    (sum, file) => {
      const changes = countDiffFileChanges(file);
      return {
        additions: sum.additions + changes.additions,
        deletions: sum.deletions + changes.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );

  return (
    <article
      className={cn(
        "space-y-3 rounded-xl p-3.5",
        accepted ? "bg-emerald-500/12" : "bg-emerald-500/8",
      )}
      data-testid="project-review-check-proposal"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            Direction {index + 1}
          </p>
          <h6 className="mt-0.5 line-clamp-2 text-sm font-semibold text-foreground">
            {proposal.title}
          </h6>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!parsedDiff.parseError && parsedDiff.files.length > 0 ? (
            <span className="flex items-center gap-1.5 font-mono text-2xs font-semibold">
              <span className="text-status-added">+{totals.additions}</span>
              <span className="text-status-deleted">-{totals.deletions}</span>
            </span>
          ) : null}
          <Button
            aria-pressed={accepted}
            className={cn(
              "shrink-0",
              accepted
                ? "border border-emerald-500/35 bg-emerald-500/10 text-emerald-700 shadow-none hover:bg-emerald-500/15 dark:text-emerald-300"
                : "bg-emerald-600 text-white hover:bg-emerald-600/90",
            )}
            disabled={accepted || !acceptEnabled}
            onClick={onAccept}
            size="sm"
            type="button"
            variant={accepted ? "secondary" : "default"}
          >
            {accepted ? <Check /> : null}
            {accepted ? "Accepted" : "Accept"}
          </Button>
        </div>
      </div>

      <details
        className="group"
        data-testid="project-review-check-proposal-details"
      >
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
          <span className="group-open:hidden">Read more</span>
          <span className="hidden group-open:inline">Hide details</span>
        </summary>
        <div className="space-y-3 pt-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {proposal.summary}
          </p>
          {proposal.truncated || !canAccept ? (
            <p className="text-2xs text-muted-foreground">
              {proposal.truncated
                ? "The patch is incomplete and cannot be selected."
                : "Run this check again to select a current proposal."}
            </p>
          ) : null}
          <ProposalDiffFiles
            files={parsedDiff.files}
            parseError={parsedDiff.parseError}
            proposal={proposal}
          />
        </div>
      </details>
    </article>
  );
}

function ReviewResponse({
  canRespond,
  onRespond,
}: {
  canRespond: boolean;
  onRespond?: (response: string) => Promise<void>;
}) {
  const [response, setResponse] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [isSending, setIsSending] = React.useState(false);
  const responseId = React.useId();
  const canSubmit =
    canRespond && Boolean(onRespond) && Boolean(response.trim());

  if (!expanded) {
    return (
      <article
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/20 p-3.5"
        data-testid="project-review-check-response"
      >
        <div>
          <p className="text-sm font-semibold text-foreground">
            Propose another direction
          </p>
          <p className="text-2xs text-muted-foreground">
            Suggest a different approach for the agent to consider.
          </p>
        </div>
        <Button
          disabled={!canRespond || !onRespond}
          onClick={() => setExpanded(true)}
          type="button"
          variant="secondary"
        >
          Propose
        </Button>
      </article>
    );
  }

  return (
    <form
      className="space-y-2 rounded-xl bg-muted/20 p-3.5"
      data-testid="project-review-check-response"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit || !onRespond) return;
        setIsSending(true);
        void onRespond(response.trim())
          .then(() => {
            setResponse("");
            setExpanded(false);
          })
          .catch(() => undefined)
          .finally(() => setIsSending(false));
      }}
    >
      <div>
        <label
          className="text-sm font-semibold text-foreground"
          htmlFor={responseId}
        >
          Propose another direction
        </label>
        <p className="text-2xs text-muted-foreground">
          Suggest a different approach for the agent to consider.
        </p>
      </div>
      <div className="flex items-end gap-2">
        <Textarea
          className="min-h-16 resize-none text-sm"
          disabled={!canRespond || isSending}
          id={responseId}
          onChange={(event) => setResponse(event.target.value)}
          placeholder="Share your reasoning or suggest a different fix…"
          rows={2}
          value={response}
        />
        <div className="flex shrink-0 items-center gap-2">
          <Button
            disabled={isSending}
            onClick={() => setExpanded(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || isSending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {isSending ? <LoaderCircle className="animate-spin" /> : null}
            Respond
          </Button>
        </div>
      </div>
    </form>
  );
}

export function ProjectReviewCheckResultCard({
  acceptedProposalEventId,
  canDecide,
  keptCurrentApproach,
  onAcceptProposal,
  onKeepCurrentApproach,
  onRespond,
  proposals,
  result,
}: {
  acceptedProposalEventId?: string;
  canDecide: boolean;
  keptCurrentApproach: boolean;
  onAcceptProposal: (eventId: string) => void;
  onKeepCurrentApproach: () => void;
  onRespond?: (response: string) => Promise<void>;
  proposals: ProjectReviewCheckResolvedProposal[];
  result: ProjectReviewCheckResult;
}) {
  const isApproved = result.conclusion === "approved";
  const title = isApproved
    ? "Aligned"
    : proposals.length > 0
      ? "Choose a direction"
      : "Review the concern";

  return (
    <section className="space-y-3" data-testid="project-review-check-result">
      <header>
        <h5 className="text-sm font-semibold text-foreground">{title}</h5>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {result.summary}
        </p>
      </header>

      {!isApproved && proposals.length === 0 && result.findings.length > 0 ? (
        <div className="divide-y divide-border/45 border-t border-border/55 px-4">
          {result.findings.map((finding) => (
            <div
              className="py-2.5"
              data-testid="project-review-check-finding"
              key={JSON.stringify(finding)}
            >
              <p className="text-xs font-medium text-foreground">
                {finding.title}
              </p>
              {finding.detail ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {finding.detail}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {proposals.length > 0 ? (
        <>
          <p className="text-2xs text-muted-foreground">
            Preview only — selecting a direction records the decision without
            changing code.
          </p>
          {proposals.map((proposal, index) => (
            <ProposalOption
              accepted={acceptedProposalEventId === proposal.eventId}
              canAccept={canDecide}
              index={index}
              key={proposal.eventId}
              onAccept={() => onAcceptProposal(proposal.eventId)}
              proposal={proposal}
            />
          ))}

          <article
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/20 p-3.5",
              keptCurrentApproach && "bg-muted/35",
            )}
          >
            <div>
              <p className="text-sm font-semibold text-foreground">
                Keep it as-is
              </p>
              <p className="text-2xs text-muted-foreground">
                Reject the proposals and leave the review unchanged.
              </p>
            </div>
            <Button
              aria-pressed={keptCurrentApproach}
              className={cn(
                "border-rose-500/35 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400",
                keptCurrentApproach && "bg-rose-500/10",
              )}
              disabled={!canDecide || keptCurrentApproach}
              onClick={onKeepCurrentApproach}
              size="sm"
              type="button"
              variant="outline"
            >
              {keptCurrentApproach ? <Check /> : <X />}
              {keptCurrentApproach ? "Keeping it as-is" : "Keep it as-is"}
            </Button>
          </article>
        </>
      ) : null}

      {!isApproved ? (
        <ReviewResponse canRespond={canDecide} onRespond={onRespond} />
      ) : null}
    </section>
  );
}

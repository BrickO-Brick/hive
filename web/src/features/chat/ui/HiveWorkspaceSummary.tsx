import {
  Archive,
  Check,
  Code2,
  Copy,
  GitBranch,
  LoaderCircle,
  Clock3,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  closeRepositoryDiscussion,
  type RepositoryDiscussion,
  repositoryDiscussionsQueryKey,
} from "@/features/repos/repository-discussions-api";

type Props = {
  discussion: RepositoryDiscussion;
  hasRoot: boolean;
  onOpenEditor: () => void;
};

export function HiveWorkspaceSummary({
  discussion,
  hasRoot,
  onOpenEditor,
}: Props) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [completionEvidence, setCompletionEvidence] = useState(
    discussion.completionEvidence ?? "",
  );
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeDialogTitleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(""), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  useEffect(() => {
    if (closeOpen) closeDialogTitleRef.current?.focus();
  }, [closeOpen]);

  const dismissClose = () => {
    setCloseOpen(false);
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied("");
    }
  };

  const values = [
    ["Branch", discussion.branchRef.replace("refs/heads/", "")],
    ["Base", discussion.baseSha],
    ["HEAD", discussion.currentHeadSha],
  ] as const;
  const snapshotDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(discussion.createdAt));

  const closed = discussion.status === "closed";
  const cleanupPending = discussion.status === "cleanup_pending";
  const requiresEvidence = Boolean(discussion.proposalRevision);

  const closeDiscussion = async () => {
    if (closing || (requiresEvidence && !completionEvidence.trim())) return;
    setClosing(true);
    setCloseError("");
    try {
      await closeRepositoryDiscussion(discussion.id, {
        expectedHeadSha: discussion.currentHeadSha,
        completionEvidence: completionEvidence.trim() || undefined,
      });
      setCloseOpen(false);
      await queryClient.invalidateQueries({
        queryKey: repositoryDiscussionsQueryKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "close_failed";
      const friendly: Record<string, string> = {
        completion_evidence_required:
          "Add the GitHub or staging evidence for this proposal.",
        workspace_has_changes:
          "The workspace still has uncommitted changes. Review and commit them first.",
        workspace_head_changed:
          "The workspace changed. Refresh this discussion before closing it.",
      };
      setCloseError(
        friendly[message] ??
          "Hive could not finish cleanup. The discussion remains recoverable and can be retried.",
      );
    } finally {
      setClosing(false);
    }
  };

  if (closed) {
    return (
      <div className="mb-4 rounded-xl border border-[#C7D4E5] bg-[#F4F7FA] p-3 text-xs text-[#526178] shadow-sm">
        <div className="flex items-center gap-2 font-bold text-[#10233F]">
          <Archive size={14} /> Discussion closed · workspace cleaned
        </div>
        <p className="mt-1.5 leading-5">
          The conversation and Git revision remain as audit history. Its
          isolated worktree and local branch have been removed
          {discussion.mirrorCleaned
            ? ", together with the unused repository mirror."
            : "; the shared repository mirror is still used by another discussion."}
        </p>
        {discussion.completionEvidence && (
          <p className="mt-2 break-all rounded border border-[#D8DEE8] bg-white px-2 py-1.5 font-mono text-[10px]">
            Completion evidence: {discussion.completionEvidence}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-[#BFD4FF] bg-[#EEF5FF] p-3 text-xs text-[#29466F] shadow-sm">
      <div className="flex flex-col items-stretch gap-3 @4xl/hive-main:flex-row @4xl/hive-main:items-center @4xl/hive-main:justify-between">
        <div className="flex items-center gap-2 font-bold text-[#10233F]">
          <GitBranch size={14} /> Isolated repository workspace
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCloseOpen(true)}
            ref={closeButtonRef}
            className="flex items-center gap-1.5 rounded-md border border-[#C7D4E5] bg-white px-2.5 py-1.5 text-[10px] font-bold text-[#526178] hover:border-[#8491A4] hover:text-[#10233F]"
          >
            <Archive size={12} /> {cleanupPending ? "Retry cleanup" : "Close"}
          </button>
          <button
            type="button"
            onClick={onOpenEditor}
            disabled={cleanupPending}
            className="flex items-center gap-1.5 rounded-md bg-[#2F6FED] px-2.5 py-1.5 text-[10px] font-bold text-white shadow-sm hover:bg-[#245CC8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2F6FED] disabled:opacity-50"
          >
            <Code2 size={12} /> Review code
          </button>
        </div>
      </div>
      <div className="mt-1.5 font-semibold">
        {discussion.owner}/{discussion.repository}
      </div>
      <p className="mt-1 text-[10px] leading-4 text-[#526178]">
        Code suggestions from this discussion stay isolated until you approve
        and apply them.
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-[10px] text-[#526178]">
        <Clock3 aria-hidden="true" size={11} /> Base snapshot created{" "}
        {snapshotDate}. Start a new discussion when work must begin from the
        latest default branch.
      </p>
      <dl className="mt-2 grid gap-1.5 @4xl/hive-main:grid-cols-3">
        {values.map(([label, value]) => (
          <div
            key={label}
            className="flex min-w-0 items-center gap-1 rounded border border-[#BFD4FF] bg-white/75 px-2 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <dt className="text-[9px] font-bold uppercase tracking-wide text-[#607086]">
                {label}
              </dt>
              <dd
                className="truncate font-mono text-[10px] text-[#29466F]"
                title={value}
              >
                {value}
              </dd>
            </div>
            <button
              type="button"
              className="grid size-7 shrink-0 place-items-center rounded text-[#526178] hover:bg-[#EEF5FF] hover:text-[#1F55C5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2F6FED]"
              aria-label={`Copy ${label.toLowerCase()} value`}
              onClick={() => void copy(label, value)}
            >
              {copied === label ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        ))}
      </dl>
      <p className="sr-only" aria-live="polite">
        {copied ? `${copied} copied` : ""}
      </p>
      {!hasRoot && (
        <p className="mt-2 font-semibold text-[#1F55C5]">
          Send the prepared first message to start this discussion thread.
        </p>
      )}
      {closeOpen && (
        <div
          aria-labelledby="close-discussion-title"
          className="mt-3 rounded-lg border border-[#F3C7BC] bg-[#FFF8F5] p-3"
          data-testid="close-discussion-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !closing) dismissClose();
          }}
          role="dialog"
        >
          <div
            className="font-bold text-[#10233F] outline-none"
            id="close-discussion-title"
            ref={closeDialogTitleRef}
            tabIndex={-1}
          >
            {cleanupPending
              ? "Retry the pending Git workspace cleanup?"
              : "Close discussion and clean its Git workspace?"}
          </div>
          <p className="mt-1 leading-5 text-[#607086]">
            Hive will retain this discussion, final revision, and completion
            evidence, then delete its worktree and local branch. A shared mirror
            is deleted only when no other open discussion uses it.
          </p>
          {requiresEvidence && (
            <label className="mt-2 block font-bold text-[#42526B]">
              GitHub or staging evidence
              <input
                className="mt-1 h-9 w-full rounded-md border border-[#D8DEE8] bg-white px-2.5 font-normal outline-none focus:border-[#2F6FED] focus:ring-4 focus:ring-[#2F6FED]/10"
                onChange={(event) =>
                  setCompletionEvidence(event.currentTarget.value)
                }
                placeholder="PR URL, staging deployment URL, or integrated commit SHA"
                value={completionEvidence}
              />
            </label>
          )}
          {closeError && (
            <p className="mt-2 font-semibold text-[#C93F4A]" role="alert">
              {closeError}
            </p>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              className="rounded-md border border-[#D8DEE8] bg-white px-3 py-2 font-bold text-[#526178] hover:bg-[#F7FAFC]"
              disabled={closing}
              onClick={dismissClose}
              type="button"
            >
              Keep open
            </button>
            <button
              className="flex items-center gap-1.5 rounded-md bg-[#10233F] px-3 py-2 font-bold text-white hover:bg-[#243B5A] disabled:opacity-50"
              disabled={
                closing || (requiresEvidence && !completionEvidence.trim())
              }
              onClick={() => void closeDiscussion()}
              type="button"
            >
              {closing && <LoaderCircle className="animate-spin" size={13} />}
              Close and clean workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

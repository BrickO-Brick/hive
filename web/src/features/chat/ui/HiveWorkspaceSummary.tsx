import { Check, Copy, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import type { RepositoryDiscussion } from "@/features/repos/repository-discussions-api";

type Props = {
  discussion: RepositoryDiscussion;
  hasRoot: boolean;
};

export function HiveWorkspaceSummary({ discussion, hasRoot }: Props) {
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(""), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

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

  return (
    <div className="mb-4 rounded-xl border border-[#BFD4FF] bg-[#EEF5FF] p-3 text-xs text-[#29466F] shadow-sm">
      <div className="flex items-center gap-2 font-bold text-[#10233F]">
        <GitBranch size={14} /> Isolated repository workspace
      </div>
      <div className="mt-1.5 font-semibold">
        {discussion.owner}/{discussion.repository}
      </div>
      <dl className="mt-2 grid gap-1.5 sm:grid-cols-3">
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
    </div>
  );
}

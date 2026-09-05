import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DiscussionWorkspaceDiff } from "@/features/repos/repository-discussions-api";

type FileDiff = {
  additions: number;
  deletions: number;
  diff: string;
  path: string;
};

type Props = {
  diff: DiscussionWorkspaceDiff;
  selectedPaths: string[];
  onSelectedPathsChange: (paths: string[]) => void;
};

function fileLabel(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function fileContext(path: string) {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "Repository root";
}

function splitFileDiffs(diff: string, paths: string[]): FileDiff[] {
  const sections = diff
    .split(/(?=^diff --git )/m)
    .filter((section) => section.trim());
  return sections.map((section, index) => {
    const header = section.match(/^diff --git a\/(.+) b\/(.+)$/m);
    const path = paths[index] ?? header?.[2] ?? `Changed file ${index + 1}`;
    let additions = 0;
    let deletions = 0;
    for (const line of section.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    return { additions, deletions, diff: section, path };
  });
}

function DiffLines({ diff }: { diff: string }) {
  const occurrences = new Map<string, number>();
  const lines = diff.split("\n").map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return { key: `${line}:${occurrence}`, line };
  });
  return (
    <pre
      className="min-h-0 flex-1 overflow-auto bg-[#FBFCFE] p-0 font-mono text-[12px] leading-6 text-[#243B5A]"
      data-testid="simple-ide-diff"
    >
      {lines.map(({ key, line }, index) => {
        const tone = line.startsWith("+")
          ? "bg-[#E7F8EE] text-[#086A3E]"
          : line.startsWith("-")
            ? "bg-[#FFF0F0] text-[#B9383E]"
            : line.startsWith("@@")
              ? "bg-[#EEF5FF] text-[#365B8D]"
              : line.startsWith("diff --git")
                ? "bg-white font-bold text-[#10233F]"
                : "";
        return (
          <div className={`min-w-max px-4 ${tone}`} key={key}>
            <span className="mr-4 inline-block w-9 select-none text-right text-[#9AA7B8]">
              {index + 1}
            </span>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function HiveReviewDiff({
  diff,
  selectedPaths,
  onSelectedPathsChange,
}: Props) {
  const fileDiffs = useMemo(
    () => splitFileDiffs(diff.diff, diff.paths ?? []),
    [diff.diff, diff.paths],
  );
  const [activePath, setActivePath] = useState(fileDiffs[0]?.path ?? "");
  useEffect(() => {
    if (!fileDiffs.some((item) => item.path === activePath)) {
      setActivePath(fileDiffs[0]?.path ?? "");
    }
  }, [activePath, fileDiffs]);
  const active =
    fileDiffs.find((item) => item.path === activePath) ?? fileDiffs[0];

  if (!active) {
    return (
      <div className="grid min-h-80 flex-1 place-items-center px-6 text-center">
        <div>
          <Check className="mx-auto text-[#18A66A]" size={28} />
          <div className="mt-3 text-sm font-bold text-[#10233F]">
            No uncommitted changes
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-44 shrink-0 overflow-y-auto border-r border-[#D8DEE8] bg-white p-2 sm:w-56">
        <div className="flex items-center justify-between px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[#607086]">
          <span>Files</span>
          <span>{selectedPaths.length} selected</span>
        </div>
        <div className="space-y-1">
          {fileDiffs.map((item) => {
            const selected = selectedPaths.includes(item.path);
            return (
              <div
                className={`flex items-center gap-1 rounded-md ${
                  active.path === item.path
                    ? "bg-[#EEF5FF]"
                    : "hover:bg-[#F7FAFC]"
                }`}
                key={item.path}
              >
                <label className="grid size-8 shrink-0 cursor-pointer place-items-center">
                  <input
                    type="checkbox"
                    checked={selected}
                    aria-label={`Include ${item.path} in approval`}
                    onChange={() =>
                      onSelectedPathsChange(
                        selected
                          ? selectedPaths.filter((path) => path !== item.path)
                          : [...selectedPaths, item.path],
                      )
                    }
                    className="size-3.5 accent-[#2F6FED]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setActivePath(item.path)}
                  className="min-w-0 flex-1 px-1 py-2 text-left"
                >
                  <span className="block truncate text-[11px] font-bold text-[#243B5A]">
                    {fileLabel(item.path)}
                  </span>
                  <span className="block truncate text-[9px] text-[#8491A4]">
                    +{item.additions} · −{item.deletions} ·{" "}
                    {fileContext(item.path)}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </aside>
      <DiffLines diff={active.diff} />
    </div>
  );
}

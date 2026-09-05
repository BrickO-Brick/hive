import {
  ArrowLeft,
  Check,
  ChevronRight,
  Code2,
  FileCode2,
  FileText,
  Folder,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  commitDiscussionWorkspace,
  type DiscussionWorkspace,
  type DiscussionWorkspaceDiff,
  type DiscussionWorkspaceFile,
  fetchDiscussionWorkspace,
  fetchDiscussionWorkspaceDiff,
  readDiscussionWorkspaceFile,
  type RepositoryDiscussion,
  searchDiscussionWorkspaceFiles,
  writeDiscussionWorkspaceFile,
} from "@/features/repos/repository-discussions-api";
import { BrickOPet } from "./BrickOPet";

type Props = {
  discussion: RepositoryDiscussion;
  onClose: () => void;
  onCommitted: (discussion: RepositoryDiscussion) => void;
};

type ViewMode = "edit" | "review";

type BrowserDraft = {
  content: string;
  digest: string;
};

const INITIAL_VISIBLE_FILES = 80;

function browserDraftKey(discussionId: string, path: string): string {
  return `hive.simple-ide.draft.v1:${discussionId}:${path}`;
}

function fileLabel(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function fileContext(path: string) {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "Repository root";
}

function languageLabel(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  const labels: Record<string, string> = {
    css: "CSS",
    dart: "Dart",
    html: "HTML",
    js: "JavaScript",
    json: "JSON",
    jsx: "JSX",
    md: "Markdown",
    py: "Python",
    rs: "Rust",
    sh: "Shell",
    sql: "SQL",
    ts: "TypeScript",
    tsx: "TSX",
    yaml: "YAML",
    yml: "YAML",
  };
  return extension ? (labels[extension] ?? extension.toUpperCase()) : "Text";
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "workspace_error";
  const friendly: Record<string, string> = {
    binary_file: "This file is binary and cannot be edited here.",
    file_changed: "Someone changed this file. Reload it before saving again.",
    file_not_editable: "This file cannot be edited safely.",
    file_too_large: "This file is too large for Simple IDE.",
    workspace_has_no_changes: "There are no saved changes to commit.",
    workspace_head_changed: "The branch changed. Refresh before committing.",
  };
  return friendly[message] ?? "The workspace could not complete that action.";
}

function statusTone(status: string | null) {
  if (status?.includes("?")) return "bg-[#DDF7E9] text-[#137A4D]";
  if (status) return "bg-[#FFF0D7] text-[#9A5B05]";
  return "bg-[#EEF3F8] text-[#607086]";
}

function DiffView({ diff }: { diff: DiscussionWorkspaceDiff }) {
  if (!diff.diff.trim()) {
    return (
      <div className="grid min-h-80 place-items-center px-6 text-center">
        <div>
          <Check className="mx-auto text-[#18A66A]" size={28} />
          <div className="mt-3 text-sm font-bold text-[#10233F]">
            No uncommitted changes
          </div>
          <p className="mt-1 text-xs text-[#607086]">
            Edit and save a file before creating a commit.
          </p>
        </div>
      </div>
    );
  }
  const occurrences = new Map<string, number>();
  const lines = diff.diff.split("\n").map((line) => {
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

export function HiveSimpleIde({ discussion, onClose, onCommitted }: Props) {
  const [workspace, setWorkspace] = useState<DiscussionWorkspace | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [file, setFile] = useState<DiscussionWorkspaceFile | null>(null);
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<ViewMode>("edit");
  const [diff, setDiff] = useState<DiscussionWorkspaceDiff | null>(null);
  const [commitMessage, setCommitMessage] = useState(
    `Update ${discussion.title.toLowerCase()}`,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileSearch, setFileSearch] = useState<{
    files: DiscussionWorkspace["files"];
    totalMatches: number;
    hasMoreFiles: boolean;
  } | null>(null);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [fileSearchError, setFileSearchError] = useState("");
  const [visibleFileLimit, setVisibleFileLimit] = useState(
    INITIAL_VISIBLE_FILES,
  );
  const [editorScrollTop, setEditorScrollTop] = useState(0);

  const changed = Boolean(file && content !== file.content);
  const confirmDiscard = useCallback(() => {
    if (!changed) return true;
    if (!window.confirm("Discard unsaved edits?")) return false;
    if (file) {
      window.localStorage.removeItem(browserDraftKey(discussion.id, file.path));
    }
    return true;
  }, [changed, discussion.id, file]);

  useEffect(() => {
    if (!changed) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const guardExternalNavigation = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest("[data-testid='simple-ide']") &&
        target.closest("button,a,[role='button']") &&
        !confirmDiscard()
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", guardExternalNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", guardExternalNavigation, true);
    };
  }, [changed, confirmDiscard]);

  const selectFile = (path: string) => {
    if (path === selectedPath || !confirmDiscard()) return;
    setSelectedPath(path);
  };

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchDiscussionWorkspace(discussion.id);
      setWorkspace(next);
      setSelectedPath((current) => {
        if (current) return current;
        return (
          next.changes[0]?.path ??
          next.files.find((item) => /readme|src\//i.test(item.path))?.path ??
          next.files[0]?.path ??
          ""
        );
      });
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [discussion.id]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    const query = fileQuery.trim();
    if (!query) {
      setFileSearch(null);
      setFileSearchError("");
      setSearchingFiles(false);
      return;
    }
    setFileSearch(null);
    setSearchingFiles(true);
    setFileSearchError("");
    let current = true;
    const timeout = window.setTimeout(() => {
      void searchDiscussionWorkspaceFiles(discussion.id, query)
        .then((result) => {
          if (current) setFileSearch(result);
        })
        .catch(() => {
          if (current) {
            setFileSearch(null);
            setFileSearchError("Could not search workspace files. Try again.");
          }
        })
        .finally(() => {
          if (current) setSearchingFiles(false);
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timeout);
    };
  }, [discussion.id, fileQuery]);

  useEffect(() => {
    if (!selectedPath) {
      setFile(null);
      setContent("");
      return;
    }
    let current = true;
    setLoading(true);
    setError("");
    void readDiscussionWorkspaceFile(discussion.id, selectedPath)
      .then((next) => {
        if (!current) return;
        setFile(next);
        const stored = window.localStorage.getItem(
          browserDraftKey(discussion.id, selectedPath),
        );
        try {
          const draft = stored ? (JSON.parse(stored) as BrowserDraft) : null;
          if (
            draft &&
            draft.digest === next.digest &&
            typeof draft.content === "string" &&
            draft.content !== next.content
          ) {
            setContent(draft.content);
            setNotice("Recovered an unsaved browser draft.");
            return;
          }
        } catch {
          window.localStorage.removeItem(
            browserDraftKey(discussion.id, selectedPath),
          );
        }
        setContent(next.content);
      })
      .catch((nextError) => {
        if (current) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [discussion.id, selectedPath]);

  useEffect(() => {
    if (!file || !changed) return;
    window.localStorage.setItem(
      browserDraftKey(discussion.id, file.path),
      JSON.stringify({ content, digest: file.digest } satisfies BrowserDraft),
    );
  }, [changed, content, discussion.id, file]);

  const save = async () => {
    if (!file || !changed) return file;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await writeDiscussionWorkspaceFile(discussion.id, {
        path: file.path,
        content,
        expectedDigest: file.digest,
      });
      setFile(saved);
      setContent(saved.content);
      window.localStorage.removeItem(
        browserDraftKey(discussion.id, saved.path),
      );
      setNotice("Draft saved in the isolated workspace.");
      await loadWorkspace();
      return saved;
    } catch (nextError) {
      setError(errorMessage(nextError));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (changed && !(await save())) return;
    setBusy(true);
    setError("");
    try {
      const next = await fetchDiscussionWorkspaceDiff(discussion.id);
      setDiff(next);
      setMode("review");
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const createCommit = async () => {
    if (!workspace || !diff?.diff.trim()) return;
    setBusy(true);
    setError("");
    try {
      const updated = await commitDiscussionWorkspace(discussion.id, {
        message: commitMessage,
        expectedHeadSha: workspace.currentHeadSha,
      });
      onCommitted(updated);
      for (const item of workspace.files) {
        window.localStorage.removeItem(
          browserDraftKey(discussion.id, item.path),
        );
      }
      setNotice(
        `Commit ${updated.currentHeadSha.slice(0, 12)} created locally.`,
      );
      setDiff(null);
      setMode("edit");
      await loadWorkspace();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const displayedFiles = useMemo(
    () =>
      fileQuery.trim() ? (fileSearch?.files ?? []) : (workspace?.files ?? []),
    [fileQuery, fileSearch, workspace],
  );

  const visibleFiles = useMemo(
    () => displayedFiles.slice(0, visibleFileLimit),
    [displayedFiles, visibleFileLimit],
  );
  const directories = useMemo(() => {
    const values = new Set<string>();
    for (const item of visibleFiles) {
      const directory = item.path.includes("/")
        ? item.path.split("/")[0]
        : "Root";
      values.add(directory);
    }
    return [...values];
  }, [visibleFiles]);
  const lineNumbers = useMemo(
    () =>
      Array.from(
        { length: content.split("\n").length },
        (_, index) => index + 1,
      ).join("\n"),
    [content],
  );

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-[#F7FAFC] px-3 pb-4 pt-3 sm:px-5"
      data-testid="simple-ide"
    >
      <div className="mx-auto mb-3 flex min-h-12 w-full max-w-[1120px] shrink-0 items-center gap-2.5 rounded-lg border border-[#FFD3C9] bg-[#FFF8F5] px-3 py-1.5">
        <BrickOPet
          label="BrickO is online and ready"
          mode="idle"
          size="sm"
          testId="simple-ide-bricko"
        />
        <div className="min-w-0">
          <div className="text-xs font-bold text-[#10233F]">
            Online and ready
          </div>
          <div className="truncate text-[10px] text-[#526178]">
            Built-in Simple IDE — edit safely, review the diff, then create a
            local commit.
          </div>
        </div>
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-[1120px] flex-1 flex-col overflow-hidden rounded-xl border border-[#D8DEE8] bg-white shadow-[0_12px_36px_rgba(16,35,63,0.08)]">
        <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[#D8DEE8] px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                if (confirmDiscard()) onClose();
              }}
              className="grid size-8 shrink-0 place-items-center rounded-md text-[#526178] hover:bg-[#EEF3F8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2F6FED]"
              aria-label="Back to discussion"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#EEF5FF] text-[#2F6FED]">
              <Code2 size={17} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-[#10233F]">
                Simple IDE
              </div>
              <div className="truncate text-[10px] text-[#607086]">
                {discussion.owner}/{discussion.repository} ·{" "}
                {discussion.branchRef.replace("refs/heads/", "")}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (confirmDiscard()) void loadWorkspace();
            }}
            disabled={busy || loading}
            className="grid size-8 place-items-center rounded-md border border-[#D8DEE8] text-[#526178] hover:bg-[#F7FAFC] disabled:opacity-50"
            aria-label="Reload workspace"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {mode === "edit" ? (
            <>
              <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-[#D8DEE8] bg-[#FBFCFE] p-3 sm:block">
                <label className="relative mb-3 block">
                  <span className="sr-only">Search workspace files</span>
                  <Search
                    aria-hidden="true"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8491A4]"
                    size={13}
                  />
                  <input
                    type="search"
                    value={fileQuery}
                    onChange={(event) => {
                      setFileQuery(event.currentTarget.value);
                      setVisibleFileLimit(INITIAL_VISIBLE_FILES);
                    }}
                    placeholder="Find file"
                    className="h-8 w-full rounded-md border border-[#D8DEE8] bg-white pl-8 pr-2 text-xs outline-none focus:border-[#2F6FED]"
                  />
                </label>
                {workspace?.hasMoreFiles && !fileQuery.trim() && (
                  <p className="mb-2 px-1 text-[10px] leading-4 text-[#607086]">
                    Showing {workspace.files.length.toLocaleString()} of{" "}
                    {workspace.totalFiles.toLocaleString()} files. Search checks
                    the full repository.
                  </p>
                )}
                {searchingFiles && (
                  <p
                    className="mb-2 px-1 text-[10px] text-[#607086]"
                    role="status"
                  >
                    Searching all workspace files…
                  </p>
                )}
                {fileSearchError && (
                  <p
                    className="mb-2 px-1 text-[10px] text-[#C93F4A]"
                    role="alert"
                  >
                    {fileSearchError}
                  </p>
                )}
                {directories.map((directory) => (
                  <div className="mb-2" key={directory}>
                    <div className="flex items-center gap-1.5 px-1 py-1 text-xs font-bold text-[#42526B]">
                      <Folder size={13} /> {directory}
                    </div>
                    {visibleFiles
                      .filter((item) =>
                        directory === "Root"
                          ? !item.path.includes("/")
                          : item.path.startsWith(`${directory}/`),
                      )
                      .map((item) => (
                        <button
                          type="button"
                          key={item.path}
                          title={item.path}
                          onClick={() => selectFile(item.path)}
                          className={`mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
                            selectedPath === item.path
                              ? "bg-[#E8F0FF] font-bold text-[#1F55C5]"
                              : "text-[#526178] hover:bg-[#EEF3F8]"
                          }`}
                        >
                          <FileCode2 size={13} className="shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {fileLabel(item.path)}
                            </span>
                            <span className="block truncate text-[9px] font-normal text-[#8491A4]">
                              {fileContext(item.path)}
                            </span>
                          </span>
                          {item.status && (
                            <span
                              className={`rounded px-1 py-0.5 text-[9px] font-bold ${statusTone(item.status)}`}
                            >
                              {item.status.trim() || "M"}
                            </span>
                          )}
                        </button>
                      ))}
                  </div>
                ))}
                {!searchingFiles && displayedFiles.length === 0 && (
                  <p className="px-2 py-4 text-center text-xs text-[#607086]">
                    No files match “{fileQuery}”.
                  </p>
                )}
                {visibleFiles.length < displayedFiles.length && (
                  <button
                    type="button"
                    className="mt-2 w-full rounded-md border border-[#D8DEE8] bg-white px-2 py-2 text-[10px] font-bold text-[#42526B] hover:bg-[#F7FAFC]"
                    onClick={() =>
                      setVisibleFileLimit(
                        (current) => current + INITIAL_VISIBLE_FILES,
                      )
                    }
                  >
                    Show more files (
                    {displayedFiles.length - visibleFiles.length} remaining)
                  </button>
                )}
                {fileSearch?.hasMoreFiles && (
                  <p className="px-2 py-2 text-center text-[10px] leading-4 text-[#607086]">
                    Showing the first {fileSearch.files.length.toLocaleString()}{" "}
                    of {fileSearch.totalMatches.toLocaleString()} matches.
                    Refine the search to narrow the list.
                  </p>
                )}
              </aside>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-h-11 shrink-0 items-center gap-1.5 border-b border-[#D8DEE8] px-3 text-xs font-semibold text-[#42526B]">
                  <FileText size={14} />
                  {selectedPath.split("/").map((part, index, all) => (
                    <span
                      className="flex min-w-0 items-center gap-1.5"
                      key={part}
                    >
                      <span
                        className={
                          index === all.length - 1
                            ? "truncate text-[#10233F]"
                            : "hidden sm:inline"
                        }
                      >
                        {part}
                      </span>
                      {index < all.length - 1 && (
                        <ChevronRight className="hidden sm:block" size={11} />
                      )}
                    </span>
                  ))}
                  {selectedPath && (
                    <span className="ml-auto shrink-0 rounded bg-[#EEF3F8] px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-[#607086]">
                      {languageLabel(selectedPath)}
                    </span>
                  )}
                </div>
                <div className="relative min-h-0 flex-1 bg-[#FBFCFE]">
                  {loading && (
                    <div className="absolute inset-0 z-10 grid place-items-center bg-white/70">
                      <LoaderCircle
                        className="animate-spin text-[#2F6FED]"
                        size={24}
                      />
                    </div>
                  )}
                  {file ? (
                    <div className="relative h-full min-h-80 overflow-hidden">
                      <pre
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-0 left-0 top-0 w-12 overflow-hidden border-r border-[#E2E8F0] bg-[#F4F7FA] px-2 py-4 text-right font-mono text-[12px] leading-6 text-[#9AA7B8] sm:py-5"
                      >
                        <span
                          className="block"
                          style={{
                            transform: `translateY(-${editorScrollTop}px)`,
                          }}
                        >
                          {lineNumbers}
                        </span>
                      </pre>
                      <textarea
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                        onScroll={(event) =>
                          setEditorScrollTop(event.currentTarget.scrollTop)
                        }
                        onKeyDown={(event) => {
                          if (
                            (event.metaKey || event.ctrlKey) &&
                            event.key.toLowerCase() === "s"
                          ) {
                            event.preventDefault();
                            void save();
                          }
                        }}
                        spellCheck={false}
                        wrap="off"
                        aria-label={`Editing ${file.path}`}
                        className="h-full min-h-80 w-full resize-none bg-transparent py-4 pl-16 pr-4 font-mono text-[13px] leading-6 text-[#132D4F] outline-none sm:py-5 sm:pr-5"
                      />
                    </div>
                  ) : (
                    <div className="grid h-full min-h-80 place-items-center text-xs text-[#607086]">
                      Select a text file to begin.
                    </div>
                  )}
                </div>
              </div>

              <aside className="hidden w-48 shrink-0 border-l border-[#D8DEE8] bg-white p-3 lg:block">
                <div className="text-xs font-bold text-[#10233F]">Changes</div>
                <div className="mt-3 space-y-1.5">
                  {(workspace?.changes ?? []).map((item) => (
                    <button
                      type="button"
                      onClick={() => selectFile(item.path)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-[#42526B] hover:bg-[#F7FAFC]"
                      key={item.path}
                    >
                      <FileCode2 size={13} />
                      <span className="min-w-0 flex-1 truncate">
                        {fileLabel(item.path)}
                      </span>
                      <span
                        className={`rounded px-1 py-0.5 text-[9px] font-bold ${statusTone(item.status)}`}
                      >
                        {item.status?.trim() || "M"}
                      </span>
                    </button>
                  ))}
                  {!workspace?.dirty && (
                    <p className="rounded-md bg-[#F7FAFC] px-2 py-3 text-[10px] leading-4 text-[#607086]">
                      Saved edits will appear here.
                    </p>
                  )}
                </div>
              </aside>
            </>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex min-h-12 items-center justify-between border-b border-[#D8DEE8] px-4">
                  <div>
                    <div className="text-sm font-bold text-[#10233F]">
                      Review proposed changes
                    </div>
                    <div className="mt-0.5 text-[10px] text-[#607086]">
                      {diff?.changedFiles ?? 0} files ·{" "}
                      <span className="text-[#138A57]">
                        +{diff?.additions ?? 0}
                      </span>{" "}
                      ·{" "}
                      <span className="text-[#C93F4A]">
                        −{diff?.deletions ?? 0}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMode("edit")}
                    className="rounded-md border border-[#D8DEE8] px-3 py-1.5 text-xs font-bold text-[#42526B] hover:bg-[#F7FAFC]"
                  >
                    Back to edit
                  </button>
                </div>
                {diff && <DiffView diff={diff} />}
              </div>
              <aside className="w-full shrink-0 border-t border-[#D8DEE8] bg-white p-4 lg:w-72 lg:border-l lg:border-t-0">
                <div className="flex items-start gap-2.5">
                  <div className="grid size-8 shrink-0 place-items-center rounded-full border border-[#18A66A] text-[#138A57]">
                    <Check size={16} />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[#10233F]">
                      Ready to commit
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-[#607086]">
                      Review the diff, name the change, then create a local
                      commit.
                    </p>
                  </div>
                </div>
                <div className="mt-5 rounded-lg border border-[#BFD4FF] bg-[#EEF5FF] p-3 text-[11px] leading-5 text-[#29466F]">
                  <div className="flex items-center gap-1.5 font-bold">
                    <ShieldCheck size={13} /> You stay in control
                  </div>
                  <p className="mt-1">
                    This action does not push, merge, or deploy the branch.
                  </p>
                </div>
                <label
                  className="mt-5 block text-[11px] font-bold text-[#42526B]"
                  htmlFor="simple-ide-commit-message"
                >
                  Commit message
                </label>
                <input
                  id="simple-ide-commit-message"
                  value={commitMessage}
                  maxLength={160}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  className="mt-1.5 w-full rounded-md border border-[#D8DEE8] px-3 py-2 text-xs text-[#10233F] outline-none focus:border-[#2F6FED] focus:ring-2 focus:ring-[#2F6FED]/10"
                />
                <button
                  type="button"
                  onClick={() => void createCommit()}
                  disabled={busy || !commitMessage.trim() || !diff?.diff.trim()}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-[#FF6547] px-3 py-2.5 text-xs font-bold text-white shadow-[0_8px_18px_rgba(255,101,71,0.22)] hover:bg-[#E8563B] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? (
                    <LoaderCircle className="animate-spin" size={14} />
                  ) : (
                    <GitCommitHorizontal size={14} />
                  )}
                  Create commit
                </button>
              </aside>
            </div>
          )}
        </div>

        <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[#D8DEE8] px-3 py-2 sm:px-4">
          <div
            className="min-w-0 text-[10px] text-[#607086]"
            aria-live="polite"
          >
            {error ? (
              <span className="font-semibold text-[#B9383E]">{error}</span>
            ) : (
              notice || "Draft only — nothing is pushed automatically."
            )}
          </div>
          {mode === "edit" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !changed}
                className="flex items-center gap-1.5 rounded-md border border-[#D8DEE8] px-3 py-2 text-xs font-bold text-[#42526B] hover:bg-[#F7FAFC] disabled:opacity-45"
              >
                <Save size={13} /> Save draft
              </button>
              <button
                type="button"
                onClick={() => void review()}
                disabled={busy || (!changed && !workspace?.dirty)}
                className="rounded-md bg-[#FF6547] px-4 py-2 text-xs font-bold text-white hover:bg-[#E8563B] disabled:opacity-45"
              >
                Review changes
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

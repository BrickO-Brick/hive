import { useMutation, useQuery } from "@tanstack/react-query";
import { FileCode2, Loader2, RotateCcw, Save } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  readGitHubRepositoryWorkspaceFile,
  type GitHubRepositoryWorkspace,
  writeGitHubRepositoryWorkspaceFile,
} from "@/shared/api/githubRepositoryWorkspace";
import { Button } from "@/shared/ui/button";

export function ProposalFileEditor({
  disabled,
  files,
  name,
  onDirtyChange,
  onSaved,
  owner,
  reposDir,
  resultTree,
  workspaceId,
}: {
  disabled: boolean;
  files: GitHubRepositoryWorkspace["files"];
  name: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (workspace: GitHubRepositoryWorkspace) => void;
  owner: string;
  reposDir?: string | null;
  resultTree: string;
  workspaceId: string;
}) {
  const [selectedPath, setSelectedPath] = React.useState(
    () => files[0]?.path ?? "",
  );
  const [draft, setDraft] = React.useState("");
  const [baseline, setBaseline] = React.useState("");
  const loadedFileKey = React.useRef("");
  const dirty = draft !== baseline;
  const selectedFile = files.find((file) => file.path === selectedPath);

  React.useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  React.useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );
  React.useEffect(() => {
    if (!selectedFile && !dirty) setSelectedPath(files[0]?.path ?? "");
  }, [dirty, files, selectedFile]);

  const fileQuery = useQuery({
    queryKey: [
      "github-proposal-file",
      owner,
      name,
      reposDir ?? "default",
      workspaceId,
      resultTree,
      selectedPath,
    ],
    queryFn: () =>
      readGitHubRepositoryWorkspaceFile({
        owner,
        name,
        reposDir,
        workspaceId,
        path: selectedPath,
        expectedResultTree: resultTree,
      }),
    enabled: Boolean(selectedPath),
    retry: false,
  });

  React.useEffect(() => {
    if (!fileQuery.data || fileQuery.data.path !== selectedPath) return;
    const nextFileKey = `${fileQuery.data.resultTree}:${fileQuery.data.path}`;
    if (loadedFileKey.current === nextFileKey) return;
    loadedFileKey.current = nextFileKey;
    setDraft(fileQuery.data.content);
    setBaseline(fileQuery.data.content);
  }, [fileQuery.data, selectedPath]);

  const saveMutation = useMutation({
    mutationFn: () =>
      writeGitHubRepositoryWorkspaceFile({
        owner,
        name,
        reposDir,
        workspaceId,
        path: selectedPath,
        content: draft,
        expectedResultTree: resultTree,
      }),
    onSuccess: (workspace) => {
      setBaseline(draft);
      onSaved(workspace);
      toast.success("File saved. Tests and approval now target the new tree.");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "The file could not be saved.",
      );
    },
  });
  const saveFile = saveMutation.mutate;
  const saving = saveMutation.isPending;

  const save = React.useCallback(() => {
    if (!dirty || disabled || saving) return;
    saveFile();
  }, [dirty, disabled, saveFile, saving]);

  return (
    <div
      className="grid min-h-96 overflow-hidden rounded-xl border border-border/60 bg-background lg:grid-cols-[15rem_minmax(0,1fr)]"
      data-testid="github-proposal-file-editor"
    >
      <div className="border-border/60 border-b bg-muted/15 lg:border-r lg:border-b-0">
        <div className="border-border/60 border-b px-3 py-2 text-2xs font-medium uppercase tracking-[0.15em] text-muted-foreground">
          Proposal files
        </div>
        <div className="max-h-44 overflow-auto p-1.5 lg:max-h-[32rem]">
          {files.map((file) => (
            <button
              className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors ${
                file.path === selectedPath
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
              key={file.path}
              onClick={() => {
                if (dirty) {
                  toast.warning(
                    "Save or discard the current file before switching.",
                  );
                  return;
                }
                setSelectedPath(file.path);
              }}
              type="button"
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <span className="shrink-0 text-emerald-600">
                +{file.additions}
              </span>
              <span className="shrink-0 text-destructive">
                -{file.deletions}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-col">
        <div className="flex min-h-11 items-center gap-2 border-border/60 border-b px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {selectedPath || "Select a file"}
          </span>
          {dirty ? (
            <span className="text-2xs text-amber-600">Unsaved</span>
          ) : null}
          <Button
            aria-label="Discard file edits"
            className="h-8 w-8"
            disabled={!dirty || disabled || saving}
            onClick={() => setDraft(baseline)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button
            className="h-8 gap-1.5"
            data-testid="github-proposal-save-file"
            disabled={!dirty || disabled || saving}
            onClick={save}
            size="sm"
            type="button"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>

        {fileQuery.isLoading ? (
          <div className="flex min-h-80 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading file…
          </div>
        ) : fileQuery.error ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground">
            <p>{fileQuery.error.message}</p>
            <Button
              onClick={() => void fileQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : (
          <textarea
            aria-label={`Edit ${selectedPath}`}
            className="min-h-80 flex-1 resize-y bg-muted/5 p-4 font-mono text-xs leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            data-testid="github-proposal-file-content"
            disabled={disabled || saving}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                save();
              }
            }}
            spellCheck={false}
            value={draft}
          />
        )}
      </div>
    </div>
  );
}

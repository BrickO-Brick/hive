import * as React from "react";
import { ArrowLeft, FileText, Pencil, Trash2 } from "lucide-react";
import { useParams } from "@tanstack/react-router";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useLongFormNoteQuery,
  useLongFormNotesQuery,
} from "@/features/notes/hooks";
import {
  longFormNoteCoordinate,
  noteDisplayTimestamp,
  plainTextExcerpt,
} from "@/features/notes/lib/notes";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { LongFormNote } from "@/shared/api/socialTypes";
import type { UserProfileSummary } from "@/shared/api/types";
import { useMediaBreakpoint } from "@/shared/hooks/use-mobile";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { cn } from "@/shared/lib/cn";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Markdown } from "@/shared/ui/markdown";
import { Skeleton } from "@/shared/ui/skeleton";
import { Textarea } from "@/shared/ui/textarea";
import { UserAvatar } from "@/shared/ui/UserAvatar";

function formatNoteDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(timestamp * 1_000));
}

function NoteListSkeleton() {
  return (
    <div
      aria-label="Loading notes"
      className="divide-y divide-border/50"
      role="status"
    >
      {[
        "notes-loading-1",
        "notes-loading-2",
        "notes-loading-3",
        "notes-loading-4",
        "notes-loading-5",
        "notes-loading-6",
      ].map((key) => (
        <div className="space-y-2 px-5 py-4" key={key}>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

function authorDetails(
  note: LongFormNote,
  profiles: Record<string, UserProfileSummary>,
  currentPubkey?: string,
) {
  const profile = profiles[normalizePubkey(note.pubkey)];
  return {
    avatarUrl: profile?.avatarUrl ?? null,
    label: resolveUserLabel({ currentPubkey, profiles, pubkey: note.pubkey }),
  };
}

function NotesList({
  currentPubkey,
  notes,
  profiles,
  selectedCoordinate,
  onSelect,
}: {
  currentPubkey?: string;
  notes: LongFormNote[];
  profiles: Record<string, UserProfileSummary>;
  selectedCoordinate: string | null;
  onSelect: (note: LongFormNote) => void;
}) {
  return (
    <ul className="divide-y divide-border/50" data-testid="notes-list">
      {notes.map((note) => {
        const author = authorDetails(note, profiles, currentPubkey);
        const selected = note.coordinate === selectedCoordinate;
        return (
          <li key={note.coordinate}>
            <button
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex w-full gap-3 px-5 py-4 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selected && "bg-muted/60",
              )}
              data-note-coordinate={note.coordinate}
              data-testid={`note-row-${note.pubkey}-${note.slug}`}
              onClick={() => onSelect(note)}
              type="button"
            >
              <UserAvatar
                avatarUrl={author.avatarUrl}
                className="mt-0.5 h-8 w-8 shrink-0"
                displayName={author.label}
                size="sm"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {note.title}
                </span>
                <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                  {plainTextExcerpt(note) || "No preview available"}
                </span>
                <span className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{author.label}</span>
                  <span aria-hidden="true">·</span>
                  <time className="shrink-0">
                    {formatNoteDate(noteDisplayTimestamp(note))}
                  </time>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function NotesError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <Alert variant="destructive">
        <AlertTitle>Notes could not be loaded</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
      <Button
        className="self-start"
        onClick={onRetry}
        type="button"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

function NotesDetail({
  canManage,
  currentPubkey,
  note,
  profiles,
  onBack,
}: {
  canManage: boolean;
  currentPubkey?: string;
  note: LongFormNote;
  profiles: Record<string, UserProfileSummary>;
  onBack?: () => void;
}) {
  const author = authorDetails(note, profiles, currentPubkey);
  const [mockState, setMockState] = React.useState<
    "reading" | "editing" | "conflict"
  >("reading");
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(note.title);
  const [draftContent, setDraftContent] = React.useState(note.content);

  React.useEffect(() => {
    setMockState("reading");
    setDeleteOpen(false);
    setDraftTitle(note.title);
    setDraftContent(note.content);
  }, [note]);

  if (mockState !== "reading") {
    return (
      <section
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="note-editor-mockup"
      >
        <div className="mx-auto flex min-h-full max-w-3xl flex-col px-8 py-6">
          <header className="flex items-center justify-between gap-4 border-b border-border/60 pb-5">
            <div>
              <p className="text-sm font-semibold">Edit note</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Draft autosaved locally · publishes as {author.label}
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setMockState("reading")} variant="ghost">
                Cancel
              </Button>
              <Button
                data-testid="mock-publish-note"
                onClick={() => setMockState("conflict")}
              >
                Publish update
              </Button>
            </div>
          </header>
          {mockState === "conflict" ? (
            <Alert className="mt-6" variant="destructive">
              <AlertTitle>A newer version replaced this note</AlertTitle>
              <AlertDescription>
                Your draft is safe. Review the latest relay version before
                publishing again; Buzz will not silently overwrite it.
              </AlertDescription>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline">
                  Review latest
                </Button>
                <Button size="sm" variant="outline">
                  Keep my draft
                </Button>
              </div>
            </Alert>
          ) : null}
          <label
            className="mt-6 space-y-2 text-sm font-medium"
            htmlFor="note-title-mockup"
          >
            <span>Title</span>
            <Input
              id="note-title-mockup"
              onChange={(event) => setDraftTitle(event.target.value)}
              value={draftTitle}
            />
          </label>
          <label
            className="mt-5 flex min-h-0 flex-1 flex-col gap-2 text-sm font-medium"
            htmlFor="note-markdown-mockup"
          >
            <span>Markdown</span>
            <Textarea
              className="min-h-80 flex-1 resize-none font-mono leading-6"
              id="note-markdown-mockup"
              onChange={(event) => setDraftContent(event.target.value)}
              value={draftContent}
            />
          </label>
          <p className="mt-3 text-xs text-muted-foreground">
            Publishing replaces the live head at {note.slug}. The relay retains
            one current version, not a revision history.
          </p>
        </div>
      </section>
    );
  }

  return (
    <>
      <article
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="note-detail"
      >
        <div className="mx-auto max-w-3xl px-8 py-6">
          {onBack ? (
            <Button
              className="mb-5 -ml-2 gap-2"
              onClick={onBack}
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="h-4 w-4" /> Back to notes
            </Button>
          ) : null}
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight">
                {note.title}
              </h1>
              {note.summary ? (
                <p className="mt-3 text-base leading-7 text-muted-foreground">
                  {note.summary}
                </p>
              ) : null}
            </div>
            {canManage ? (
              <div
                className="flex shrink-0 gap-2"
                data-testid="note-owner-actions"
              >
                <Button
                  className="gap-2"
                  onClick={() => setMockState("editing")}
                  size="sm"
                  variant="outline"
                >
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
                <Button
                  aria-label="Delete note"
                  onClick={() => setDeleteOpen(true)}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
          </div>
          <div className="mt-5 flex items-center gap-3 border-b border-border/60 pb-6 text-sm text-muted-foreground">
            <UserAvatar
              avatarUrl={author.avatarUrl}
              className="h-8 w-8"
              displayName={author.label}
              size="sm"
            />
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground">
                {author.label}
              </div>
              <time>{formatNoteDate(noteDisplayTimestamp(note))}</time>
            </div>
          </div>
          <div className="mt-7 text-sm leading-7 text-foreground">
            <Markdown
              blockCode
              content={note.content}
              hardLineBreaks={false}
              interactive
            />
          </div>
        </div>
      </article>
      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent className="max-w-md" data-testid="delete-note-mockup">
          <DialogHeader>
            <DialogTitle>Request deletion?</DialogTitle>
            <DialogDescription>
              This publishes a signed deletion request for “{note.title}”. The
              connected relay may remove its current copy, but propagated copies
              can remain and the same slug can be published again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
            {note.coordinate}
          </div>
          <DialogFooter>
            <Button onClick={() => setDeleteOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button variant="destructive">Request deletion</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function NotesScreen() {
  const params = useParams({ strict: false }) as {
    author?: string;
    slug?: string;
  };
  const listQuery = useLongFormNotesQuery();
  const detailQuery = useLongFormNoteQuery(params.author, params.slug);
  const identityQuery = useIdentityQuery();
  const isNarrow = useMediaBreakpoint(600);
  const { goLongFormNote, goNotes } = useAppNavigation();
  const notes = listQuery.data ?? [];
  const selectedCoordinate =
    params.author && params.slug
      ? longFormNoteCoordinate(params.author, params.slug)
      : null;
  const selectedFromList =
    notes.find((note) => note.coordinate === selectedCoordinate) ?? null;
  const selectedNote = detailQuery.isError
    ? null
    : (detailQuery.data ?? selectedFromList);
  const profilePubkeys = React.useMemo(
    () => [
      ...new Set([
        ...notes.map((note) => note.pubkey),
        ...(selectedNote ? [selectedNote.pubkey] : []),
      ]),
    ],
    [notes, selectedNote],
  );
  const profilesQuery = useUsersBatchQuery(profilePubkeys, {
    enabled: profilePubkeys.length > 0,
  });
  const profiles = profilesQuery.data?.profiles ?? {};

  React.useEffect(() => {
    if (!isNarrow && !selectedCoordinate && notes[0]) {
      void goLongFormNote(notes[0].pubkey, notes[0].slug, { replace: true });
    }
  }, [goLongFormNote, isNarrow, notes, selectedCoordinate]);

  const handleBack = React.useCallback(async () => {
    const coordinateToRestore = selectedCoordinate;
    await goNotes();
    window.requestAnimationFrame(() => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("[data-note-coordinate]"),
      ).find(
        (candidate) => candidate.dataset.noteCoordinate === coordinateToRestore,
      );
      row?.focus();
    });
  }, [goNotes, selectedCoordinate]);

  const showList = !isNarrow || !selectedCoordinate;
  const showDetail = !isNarrow || Boolean(selectedCoordinate);
  const listError =
    listQuery.error instanceof Error
      ? listQuery.error.message
      : "The relay returned an error.";

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-testid="notes-view"
    >
      {showList ? (
        <section className="flex min-h-0 w-full shrink-0 flex-col border-r border-border/60 sm:w-[22.8125rem]">
          <header className="flex min-h-12 items-center border-b border-border/60 px-5">
            <h2 className="text-sm font-semibold">Notes</h2>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {listQuery.isLoading ? <NoteListSkeleton /> : null}
            {listQuery.isError && notes.length === 0 ? (
              <NotesError
                message={listError}
                onRetry={() => void listQuery.refetch()}
              />
            ) : null}
            {listQuery.isSuccess && notes.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
                <FileText className="h-8 w-8" />
                <p>No notes yet</p>
              </div>
            ) : null}
            {notes.length > 0 ? (
              <NotesList
                currentPubkey={identityQuery.data?.pubkey}
                notes={notes}
                onSelect={(note) => void goLongFormNote(note.pubkey, note.slug)}
                profiles={profiles}
                selectedCoordinate={selectedCoordinate}
              />
            ) : null}
          </div>
        </section>
      ) : null}
      {showDetail ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {selectedCoordinate && detailQuery.isLoading && !selectedFromList ? (
            <div
              className="mx-auto w-full max-w-3xl space-y-4 px-8 py-8"
              role="status"
            >
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-8 h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : null}
          {detailQuery.isError ? (
            <NotesError
              message={
                detailQuery.error instanceof Error
                  ? detailQuery.error.message
                  : "The relay returned an error."
              }
              onRetry={() => void detailQuery.refetch()}
            />
          ) : null}
          {selectedCoordinate && detailQuery.isSuccess && !selectedNote ? (
            <div
              className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground"
              role="alert"
            >
              This note could not be found.
            </div>
          ) : null}
          {selectedNote ? (
            <NotesDetail
              canManage={
                normalizePubkey(selectedNote.pubkey) ===
                normalizePubkey(identityQuery.data?.pubkey ?? "")
              }
              currentPubkey={identityQuery.data?.pubkey}
              note={selectedNote}
              onBack={isNarrow ? handleBack : undefined}
              profiles={profiles}
            />
          ) : null}
          {(!selectedCoordinate || notes.length === 0) &&
          !listQuery.isLoading &&
          !listQuery.isError ? (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              {notes.length === 0 ? "No notes yet" : "Select a note"}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

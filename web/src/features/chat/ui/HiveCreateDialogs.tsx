import { Plus, RefreshCw, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import type { OneBrickGitHubRepository } from "@/features/repos/onebrick-github-api";

function DialogFrame({
  children,
  eyebrow,
  labelId,
  onClose,
  onSubmit,
  title,
}: {
  children: ReactNode;
  eyebrow: string;
  labelId: string;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  title: ReactNode;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const initialFocus =
        dialog?.querySelector<HTMLElement>(
          "input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
        ) ??
        dialog?.querySelector<HTMLElement>(
          "input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
      initialFocus?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
    };
  }, []);

  const keepFocusInside = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[#10213F]/40 p-4 backdrop-blur-[1px]"
      role="presentation"
    >
      <form
        ref={dialogRef}
        onSubmit={onSubmit}
        onKeyDown={keepFocusInside}
        className="w-full max-w-lg rounded-2xl border border-[#D8DEE8] bg-white p-5 shadow-[0_24px_80px_rgba(16,35,63,0.25)]"
        aria-labelledby={labelId}
        aria-modal="true"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[#E35E43]">
              {eyebrow}
            </div>
            <h2 id={labelId} className="mt-1 text-lg font-bold text-[#10233F]">
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="grid size-8 place-items-center rounded border border-[#D8DEE8] text-[#526178] hover:bg-[#F7FAFC]"
            onClick={onClose}
            aria-label={`Close ${eyebrow.toLowerCase()}`}
          >
            <X size={15} />
          </button>
        </div>
        {children}
      </form>
    </div>
  );
}

function DialogActions({
  busy,
  disabled,
  busyLabel,
  onClose,
  submitLabel,
}: {
  busy: boolean;
  busyLabel: string;
  disabled: boolean;
  onClose: () => void;
  submitLabel: string;
}) {
  return (
    <div className="mt-5 flex justify-end gap-2">
      <button
        type="button"
        className="rounded-md border border-[#D8DEE8] px-4 py-2 text-xs font-bold text-[#526178]"
        onClick={onClose}
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy || disabled}
        className="flex items-center gap-2 rounded-md bg-[#FF6F52] px-4 py-2 text-xs font-bold text-white hover:bg-[#E35E43] disabled:cursor-not-allowed disabled:bg-[#E2E8F0] disabled:text-[#8491A4]"
      >
        {busy ? (
          <RefreshCw size={14} className="animate-spin" />
        ) : (
          <Plus size={14} />
        )}
        {busy ? busyLabel : submitLabel}
      </button>
    </div>
  );
}

function DialogError({ error }: { error: string }) {
  return error ? (
    <div
      className="mt-3 rounded border border-[#F4BDC2] bg-[#FFF3F4] px-3 py-2 text-xs text-[#C93F4A]"
      role="alert"
    >
      {error}
    </div>
  ) : null;
}

export function HiveNewConversationDialog({
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
  title,
}: {
  busy: boolean;
  error: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  title: string;
}) {
  return (
    <DialogFrame
      eyebrow="New chat"
      labelId="new-conversation-title"
      onClose={onClose}
      onSubmit={onSubmit}
      title="Start a group conversation"
    >
      <p className="mt-3 text-sm leading-6 text-[#607086]">
        Chats live outside repositories and are visible to every member of this
        Hive workspace. Members can join the conversation and reply in threads.
      </p>
      <label
        className="mt-4 block text-xs font-bold text-[#42526B]"
        htmlFor="conversation-title-input"
      >
        Chat name
      </label>
      <input
        id="conversation-title-input"
        data-testid="conversation-title-input"
        required
        maxLength={80}
        value={title}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="e.g. Engineering"
        className="mt-1.5 h-11 w-full rounded-md border border-[#D8DEE8] px-3 text-sm outline-none focus:border-[#2F6FED]/70 focus:ring-4 focus:ring-[#2F6FED]/10"
      />
      <DialogError error={error} />
      <DialogActions
        busy={busy}
        busyLabel="Creating…"
        disabled={!title.trim()}
        onClose={onClose}
        submitLabel="Create chat"
      />
    </DialogFrame>
  );
}

export function HiveNewDiscussionDialog({
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
  repository,
  title,
}: {
  busy: boolean;
  error: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  repository: OneBrickGitHubRepository;
  title: string;
}) {
  return (
    <DialogFrame
      eyebrow="New repository discussion"
      labelId="new-discussion-title"
      onClose={onClose}
      onSubmit={onSubmit}
      title={`${repository.owner}/${repository.name}`}
    >
      <p className="mt-3 text-sm leading-6 text-[#607086]">
        Hive will refresh one shared repository mirror, then create a dedicated
        branch and worktree for this topic. Other discussions never share its
        mutable files.
      </p>
      <label
        className="mt-4 block text-xs font-bold text-[#42526B]"
        htmlFor="discussion-title-input"
      >
        Discussion title
      </label>
      <input
        id="discussion-title-input"
        data-testid="discussion-title-input"
        required
        maxLength={160}
        value={title}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="e.g. Improve the payment reconciliation flow"
        className="mt-1.5 h-11 w-full rounded-md border border-[#D8DEE8] px-3 text-sm outline-none focus:border-[#FF6F52]/70 focus:ring-4 focus:ring-[#FF6F52]/10"
      />
      <div className="mt-3 rounded-lg border border-[#E2E8F0] bg-[#F7FAFC] px-3 py-2 text-xs text-[#526178]">
        Base branch: <strong>{repository.default_branch}</strong>. No GitHub
        push is performed when this discussion is created.
      </div>
      <DialogError error={error} />
      <DialogActions
        busy={busy}
        busyLabel="Preparing workspace…"
        disabled={!title.trim()}
        onClose={onClose}
        submitLabel="Create discussion"
      />
    </DialogFrame>
  );
}

import {
  Bot,
  Check,
  Plus,
  RefreshCw,
  Search,
  UserRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { OneBrickGitHubRepository } from "@/features/repos/onebrick-github-api";
import type { HiveParticipant } from "./useHiveParticipantDirectory";

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
  onToggleParticipant,
  onSubmit,
  participants,
  selectedPubkeys,
  title,
}: {
  busy: boolean;
  error: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onToggleParticipant: (pubkey: string) => void;
  onSubmit: (event: FormEvent) => void;
  participants: HiveParticipant[];
  selectedPubkeys: Set<string>;
  title: string;
}) {
  const [peopleQuery, setPeopleQuery] = useState("");
  const selectableParticipants = useMemo(
    () => participants.filter((participant) => !participant.isCurrentUser),
    [participants],
  );
  const selectedParticipants = selectableParticipants.filter((participant) =>
    selectedPubkeys.has(participant.pubkey),
  );
  const normalizedQuery = peopleQuery.trim().toLowerCase();
  const filteredParticipants = selectableParticipants.filter(
    (participant) =>
      !normalizedQuery ||
      participant.displayName.toLowerCase().includes(normalizedQuery) ||
      participant.role.toLowerCase().includes(normalizedQuery),
  );
  return (
    <DialogFrame
      eyebrow="New chat"
      labelId="new-conversation-title"
      onClose={onClose}
      onSubmit={onSubmit}
      title="Start a private chat"
    >
      <p className="mt-3 text-sm leading-6 text-[#607086]">
        Choose up to eight teammates. Only the selected people and you can see
        this chat or its threads.
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
      <fieldset className="mt-4">
        <legend className="text-xs font-bold text-[#42526B]">
          People ({selectedPubkeys.size}/8)
        </legend>
        {selectedParticipants.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedParticipants.map((participant) => (
              <button
                key={participant.pubkey}
                type="button"
                onClick={() => onToggleParticipant(participant.pubkey)}
                className="flex h-7 items-center gap-1.5 rounded-full border border-[#BFD4FF] bg-[#EEF5FF] pl-2.5 pr-1.5 text-[11px] font-bold text-[#1F55C5]"
                aria-label={`Remove ${participant.displayName}`}
              >
                {participant.displayName} <X size={12} />
              </button>
            ))}
          </div>
        )}
        <label className="relative mt-2 block">
          <span className="sr-only">Search people</span>
          <Search
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8491A4]"
            size={14}
          />
          <input
            value={peopleQuery}
            onChange={(event) => setPeopleQuery(event.currentTarget.value)}
            placeholder="Search people…"
            className="h-10 w-full rounded-lg border border-[#D8DEE8] bg-[#F9FBFD] pl-9 pr-3 text-sm outline-none focus:border-[#2F6FED]/60 focus:bg-white focus:ring-4 focus:ring-[#2F6FED]/10"
          />
        </label>
        <div
          className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-[#D8DEE8] p-1.5"
          data-testid="conversation-participants"
        >
          {filteredParticipants.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-[#607086]">
              No people match “{peopleQuery}”.
            </p>
          ) : (
            filteredParticipants.map((participant) => {
              const selected = selectedPubkeys.has(participant.pubkey);
              const disabled = !selected && selectedPubkeys.size >= 8;
              return (
                <label
                  key={participant.pubkey}
                  className={`relative flex min-h-11 items-center gap-3 rounded-md px-2.5 py-2 text-left transition ${
                    disabled
                      ? "cursor-not-allowed opacity-45"
                      : "cursor-pointer hover:bg-[#F7FAFC]"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="absolute inset-0 z-10 cursor-pointer opacity-0 disabled:cursor-not-allowed"
                    checked={selected}
                    disabled={disabled}
                    onChange={() => onToggleParticipant(participant.pubkey)}
                  />
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-full ${
                      participant.isAgent
                        ? "bg-[#EEEAFE] text-[#6741D9]"
                        : "bg-[#EEF5FF] text-[#1F55C5]"
                    }`}
                  >
                    {participant.isAgent ? (
                      <Bot size={15} />
                    ) : (
                      <UserRound size={15} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-[#172033]">
                      {participant.displayName}
                    </span>
                    <span className="block truncate text-xs text-[#607086]">
                      {participant.isAgent
                        ? "AI teammate"
                        : `${participant.role} · ${participant.identityHint}`}
                    </span>
                  </span>
                  <span
                    className={`grid size-5 shrink-0 place-items-center rounded border ${
                      selected
                        ? "border-[#2F6FED] bg-[#2F6FED] text-white"
                        : "border-[#C8D1DE] bg-white text-transparent"
                    }`}
                    aria-hidden="true"
                  >
                    <Check size={13} />
                  </span>
                </label>
              );
            })
          )}
        </div>
      </fieldset>
      <DialogError error={error} />
      <DialogActions
        busy={busy}
        busyLabel="Creating…"
        disabled={!title.trim() || selectedPubkeys.size === 0}
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

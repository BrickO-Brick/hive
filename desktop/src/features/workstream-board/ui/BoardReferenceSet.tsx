import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { parseBoardReferences } from "@/features/workstream-board/lib/boardReferences";

export const BOARD_REPLAY_STORAGE_KEY = "buzz:board-replay:v1";

export function BoardReferenceSet({
  tags,
}: {
  tags?: readonly (readonly string[])[];
}) {
  const references = parseBoardReferences(tags);
  const { goWorkstreams } = useAppNavigation();
  if (references.length === 0) return null;
  return (
    <button
      className="mt-2 flex w-full flex-wrap gap-1.5 rounded-lg border bg-muted/40 p-2 text-left"
      data-testid="message-board-references"
      onClick={() => {
        sessionStorage.setItem(
          BOARD_REPLAY_STORAGE_KEY,
          JSON.stringify(references),
        );
        void goWorkstreams();
      }}
      type="button"
    >
      {references.map((reference, index) => (
        <span
          className="rounded-full border bg-background px-2 py-1 text-3xs"
          key={`${reference.kind}:${reference.identity}`}
        >
          {index + 1}. {reference.kind}: {reference.snapshot.label}
        </span>
      ))}
    </button>
  );
}

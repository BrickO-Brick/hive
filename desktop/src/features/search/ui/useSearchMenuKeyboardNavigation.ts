import * as React from "react";

import type { SearchResult } from "@/features/search/ui/SearchResultItem";

export function useSearchMenuKeyboardNavigation({
  actionMenuIndex,
  activeResults,
  onActivateAction,
  onOpenResult,
  onRemoveScope,
  query,
  scopeActive,
  selectedMenuIndex,
  setSelectedMenuIndex,
}: {
  actionMenuIndex: number | null;
  activeResults: SearchResult[];
  onActivateAction: () => void;
  onOpenResult: (result: SearchResult) => void;
  onRemoveScope: () => void;
  query: string;
  scopeActive: boolean;
  selectedMenuIndex: number;
  setSelectedMenuIndex: React.Dispatch<React.SetStateAction<number>>;
}) {
  const selectableCount =
    activeResults.length + (actionMenuIndex === null ? 0 : 1);

  React.useEffect(() => {
    setSelectedMenuIndex((current) => {
      if (selectableCount === 0) return 0;
      return Math.min(current, selectableCount - 1);
    });
  }, [selectableCount, setSelectedMenuIndex]);

  React.useEffect(() => {
    const selectedResult = document.querySelector<HTMLElement>(
      `[data-search-result-index="${selectedMenuIndex}"]`,
    );
    selectedResult?.scrollIntoView({ block: "nearest" });
  }, [selectedMenuIndex]);

  const handleDialogInputKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Backspace" && query.length === 0 && scopeActive) {
        event.preventDefault();
        onRemoveScope();
        return;
      }

      if (event.key === "ArrowDown" && selectableCount > 0) {
        event.preventDefault();
        setSelectedMenuIndex((current) =>
          Math.min(current + 1, selectableCount - 1),
        );
        return;
      }

      if (event.key === "ArrowUp" && selectableCount > 0) {
        event.preventDefault();
        setSelectedMenuIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (actionMenuIndex === selectedMenuIndex) {
          onActivateAction();
          return;
        }
        const resultIndex =
          actionMenuIndex !== null && selectedMenuIndex > actionMenuIndex
            ? selectedMenuIndex - 1
            : selectedMenuIndex;
        const result = activeResults[resultIndex];
        if (result) onOpenResult(result);
      }
    },
    [
      actionMenuIndex,
      activeResults,
      onActivateAction,
      onOpenResult,
      onRemoveScope,
      query.length,
      scopeActive,
      selectableCount,
      selectedMenuIndex,
      setSelectedMenuIndex,
    ],
  );

  return handleDialogInputKeyDown;
}

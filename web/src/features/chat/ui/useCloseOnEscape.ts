import { type Dispatch, type SetStateAction, useEffect } from "react";

export function useCloseOnEscape(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, setOpen]);
}

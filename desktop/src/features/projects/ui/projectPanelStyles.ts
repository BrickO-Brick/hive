/** Settings-aligned action button used at the right edge of panel headers. */
export const PROJECT_PANEL_ACTION_BUTTON_CLASS =
  "h-auto shrink-0 gap-1.5 rounded-full border-transparent bg-muted px-3 py-1.5 text-sm font-medium text-foreground shadow-none hover:bg-muted/80";

/**
 * Shared trigger for the selection dropdowns (repository, source, branch) so
 * they read as one consistent control family in the workspace header.
 */
export const PROJECT_PICKER_TRIGGER_CLASS =
  "h-7 max-w-full shrink-0 gap-1.5 rounded-md px-3 text-sm font-medium hover:border-input";

/** Bordered shell that lets the project page surface show through. */
export const PROJECT_DETAIL_PANEL_CLASS =
  "overflow-hidden rounded-xl border border-border/60 bg-transparent";

/**
 * Detail + meta rail: two columns when the project pane itself is wide enough.
 * Uses a container query so opening the conversation panel reflows the rail
 * instead of clipping it against a viewport `xl` breakpoint.
 */
export const PROJECT_DETAIL_META_GRID_WIDE_CLASS =
  "[@container(min-width:48rem)]:grid-cols-[minmax(0,1fr)_18rem]";

/** Left border for the meta rail when it sits beside the detail column. */
export const PROJECT_DETAIL_META_RAIL_WIDE_BORDER_CLASS =
  "[@container(min-width:48rem)]:border-l [@container(min-width:48rem)]:border-t-0";

/** Empty or loading state using the same transparent project panel shell. */
export const PROJECT_DETAIL_PANEL_MESSAGE_CLASS =
  "rounded-xl border border-border/60 bg-transparent p-4 text-sm text-muted-foreground";

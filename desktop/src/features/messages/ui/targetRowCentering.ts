const CENTERED_ROW_TOLERANCE_PX = 2;

function resolveCssLength(value: string) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return value.trim().endsWith("rem")
    ? parsed *
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    : parsed;
}

export function getTargetRowCenterOffset(
  row: Element,
  container: HTMLDivElement,
) {
  const rowRect = row.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const styles = getComputedStyle(container);
  const viewportTop =
    containerRect.top +
    resolveCssLength(styles.getPropertyValue("--channel-top-chrome-height"));
  const viewportBottom =
    containerRect.bottom -
    resolveCssLength(styles.getPropertyValue("--composer-overlay-height"));
  return (
    (rowRect.top + rowRect.bottom) / 2 - (viewportTop + viewportBottom) / 2
  );
}

/**
 * A virtualized jump is complete only when the row's midpoint reaches the
 * viewport midpoint. Two pixels absorb fractional layout and Virtua's rounded
 * scroll offsets. The newest row is the one intentional exception: the list
 * clamps it to the physical floor, where exact centering is impossible.
 */
export function isTargetRowCentered(
  row: Element,
  container: HTMLDivElement,
  allowBottomClamp: boolean,
  isAtBottom: (container: HTMLDivElement) => boolean,
) {
  const rowRect = row.getBoundingClientRect();
  if (rowRect.bottom - rowRect.top <= 0) return false;
  if (
    Math.abs(getTargetRowCenterOffset(row, container)) <=
    CENTERED_ROW_TOLERANCE_PX
  ) {
    return true;
  }
  return allowBottomClamp && isAtBottom(container);
}

export function targetRowNeedsCenterCorrection(offset: number) {
  return Math.abs(offset) > CENTERED_ROW_TOLERANCE_PX;
}

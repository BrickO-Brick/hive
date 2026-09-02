import hiveLogoUrl from "../../../../../web/src/assets/hive-logo.svg";

/**
 * Hive's wordmark keeps Brick's geometric mark at the center of a connected
 * honeycomb, so the parent brand remains recognizable without the old bee.
 */
export function HiveWordmark({ className }: { className?: string }) {
  return (
    <img
      alt="Hive"
      className={["block h-auto", className].filter(Boolean).join(" ")}
      src={hiveLogoUrl}
    />
  );
}

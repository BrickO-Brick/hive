import celebrateCheckUrl from "@/assets/bricko-pet/celebrate-check.png";
import celebrateCodeUrl from "@/assets/bricko-pet/celebrate-code.png";
import celebrateSparkleUrl from "@/assets/bricko-pet/celebrate-sparkle.png";
import idleUrl from "@/assets/bricko-pet/idle.png";
import thinkingUrl from "@/assets/bricko-pet/thinking.png";

export type BrickOPetMode =
  | "still"
  | "idle"
  | "thinking"
  | "celebrate"
  | "offline";

export type BrickOCelebration = "sparkle" | "check" | "code";

const SIZE_CLASS = {
  sm: "size-8",
  md: "size-12",
  lg: "size-24",
} as const;

const CELEBRATION_SPRITES = {
  check: celebrateCheckUrl,
  code: celebrateCodeUrl,
  sparkle: celebrateSparkleUrl,
} as const;

export function BrickOPet({
  celebration = "sparkle",
  className,
  label,
  mode,
  size = "md",
  testId,
}: {
  celebration?: BrickOCelebration;
  className?: string;
  label?: string;
  mode: BrickOPetMode;
  size?: keyof typeof SIZE_CLASS;
  testId?: string;
}) {
  const sprite =
    mode === "thinking"
      ? { name: "thinking", url: thinkingUrl }
      : mode === "celebrate"
        ? {
            name: `celebrate-${celebration}`,
            url: CELEBRATION_SPRITES[celebration],
          }
        : { name: "idle", url: idleUrl };

  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={`bricko-pet bricko-pet--${mode} bricko-pet--${celebration} ${SIZE_CLASS[size]} ${className ?? ""}`}
      data-celebration={mode === "celebrate" ? celebration : undefined}
      data-mode={mode}
      data-sprite={sprite.name}
      data-testid={testId}
      role="img"
    >
      <span aria-hidden className="bricko-pet__shadow" />
      {mode === "thinking" ? (
        <span aria-hidden className="bricko-pet__trail">
          <span />
          <span />
          <span />
        </span>
      ) : null}
      <img
        alt=""
        className="bricko-pet__image"
        draggable={false}
        src={sprite.url}
      />
      {mode === "thinking" ? (
        <span aria-hidden className="bricko-pet__thoughts">
          <span />
          <span />
          <span />
        </span>
      ) : null}
      {mode === "celebrate" ? (
        <span aria-hidden className="bricko-pet__celebration">
          <span>
            {celebration === "check"
              ? "✓"
              : celebration === "code"
                ? "&lt;/&gt;"
                : "✦"}
          </span>
          <span>
            {celebration === "check"
              ? "●"
              : celebration === "code"
                ? "{ }"
                : "✧"}
          </span>
          <span>
            {celebration === "check" ? "✓" : celebration === "code" ? "/" : "✦"}
          </span>
        </span>
      ) : null}
    </span>
  );
}

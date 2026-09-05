import {
  BrickOPet,
  type BrickOCelebration,
  type BrickOPetMode,
} from "./BrickOPet";
import type { HiveAgentState } from "./HiveNavigation";

export function HiveBrickOStatusBanner({
  agentState,
  celebration,
  connected,
  petMode,
  petStatus,
  toneClasses,
  typing,
  waiting,
}: {
  agentState: HiveAgentState;
  celebration: BrickOCelebration | null;
  connected: boolean;
  petMode: BrickOPetMode;
  petStatus: string;
  toneClasses: string;
  typing: boolean;
  waiting: boolean;
}) {
  return (
    <div
      className="mx-3 mt-2 flex min-h-12 shrink-0 items-center gap-2.5 rounded-lg border border-[#FFD3C9] bg-[#FFF8F5] px-3 py-1.5 sm:mx-5"
      aria-live="polite"
      data-testid="bricko-status-banner"
    >
      <div className="relative grid size-9 shrink-0 place-items-center">
        <BrickOPet
          celebration={celebration ?? "sparkle"}
          key={celebration ?? petMode}
          label={petStatus}
          mode={petMode}
          size="sm"
          testId="bricko-status-pet"
        />
        <span
          className={`absolute bottom-0 right-0 size-3 rounded-full border-2 border-white shadow-sm ${toneClasses}`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-[#10233F]">
          {agentState.label}
        </div>
        <div className="mt-0.5 truncate text-xs text-[#526178]">
          {petStatus}
        </div>
      </div>
      {connected && (waiting || typing) && (
        <div className="flex gap-1" aria-hidden="true">
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="size-1.5 animate-bounce rounded-full bg-[#FF6F52]"
              style={{ animationDelay: `${dot * 120}ms` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

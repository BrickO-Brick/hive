import * as React from "react";
import { BookOpen, Check, Plus, X } from "lucide-react";

import {
  listMyRelaySkills,
  type RelaySkillCover,
  type ResolvedRelaySkill,
} from "@/shared/api/tauriPersonas";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { RelaySkillPreviewButton } from "./RelaySkillPreviewButton";
import { toggleRelaySkillCoordinate } from "./relaySkillPickerState";
import { PERSONA_FIELD_SHELL_CLASS } from "./agentConfigOptions";

type RelaySkillPickerProps = {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  labelFor: string;
  selected: readonly string[];
  onChange: (coordinates: string[]) => void;
  onEdit: (detail: ResolvedRelaySkill | null) => void;
  publishedSkills: readonly RelaySkillCover[];
};

type LoadState = "loading" | "ready" | "error";

export function RelaySkillPicker({
  children,
  disabled = false,
  label,
  labelFor,
  selected,
  onChange,
  onEdit,
  publishedSkills,
}: RelaySkillPickerProps) {
  const [skills, setSkills] = React.useState<RelaySkillCover[]>([]);
  const [loadState, setLoadState] = React.useState<LoadState>("loading");
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const loadSkills = React.useCallback(async () => {
    setLoadState("loading");
    try {
      setSkills(await listMyRelaySkills());
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, []);

  React.useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const visibleSkills = React.useMemo(
    () => [
      ...publishedSkills,
      ...skills.filter(
        (skill) =>
          !publishedSkills.some(
            (published) => published.coordinate === skill.coordinate,
          ),
      ),
    ],
    [publishedSkills, skills],
  );
  const knownCoordinates = React.useMemo(
    () => new Set(visibleSkills.map((skill) => skill.coordinate)),
    [visibleSkills],
  );
  const unknownSelected =
    loadState === "ready"
      ? selected.filter((coordinate) => !knownCoordinates.has(coordinate))
      : [];
  const selectedSkills = selected
    .map((coordinate) =>
      visibleSkills.find((skill) => skill.coordinate === coordinate),
    )
    .filter((skill): skill is RelaySkillCover => skill !== undefined);
  const hasSelectedSkills =
    selectedSkills.length > 0 || unknownSelected.length > 0;

  function toggleSkill(skill: RelaySkillCover) {
    if (disabled) return;
    const next = toggleRelaySkillCoordinate(selected, skill);
    if (
      next.length !== selected.length ||
      next.some((coordinate, index) => coordinate !== selected[index])
    ) {
      onChange(next);
    }
  }

  function openCreateEditor() {
    setPickerOpen(false);
    onEdit(null);
  }

  function openEditEditor(detail: ResolvedRelaySkill) {
    setPickerOpen(false);
    onEdit(detail);
  }

  function renderPickerIngress() {
    if (loadState !== "ready") return null;

    if (visibleSkills.length === 0) {
      return (
        <button
          aria-label="Create shared instruction"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted/65 text-foreground hover:bg-muted"
          disabled={disabled}
          onClick={openCreateEditor}
          title="Create shared instruction"
          type="button"
        >
          <BookOpen className="h-3.5 w-3.5" />
        </button>
      );
    }

    return (
      <DropdownMenu
        modal={false}
        onOpenChange={setPickerOpen}
        open={pickerOpen}
      >
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Add shared instructions"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted/65 text-foreground hover:bg-muted"
            disabled={disabled}
            title="Browse shared instructions"
            type="button"
          >
            <BookOpen className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-2"
          onCloseAutoFocus={(event) => event.preventDefault()}
          onFocusOutside={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('[data-testid="relay-skill-hover-card"]')
            ) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('[data-testid="relay-skill-hover-card"]')
            ) {
              event.preventDefault();
            }
          }}
          side="left"
          sideOffset={5}
        >
          <div className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-contain">
            {visibleSkills.map((skill) => (
              <RelaySkillPreviewButton
                asChild
                key={skill.coordinate}
                onEdit={openEditEditor}
                previewSide="left"
                skill={skill}
              >
                <DropdownMenuCheckboxItem
                  checked={selected.includes(skill.coordinate)}
                  className="group gap-2 px-2 py-1 [&>span:first-child]:hidden"
                  disabled={disabled || !skill.compatible}
                  onCheckedChange={() => toggleSkill(skill)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="line-clamp-1 text-xs font-medium text-foreground"
                      data-testid="relay-skill-menu-title"
                    >
                      {skill.title || skill.slug}
                    </span>
                    {skill.summary ? (
                      <span
                        className="mt-0.5 block truncate text-2xs font-light leading-5 text-muted-foreground"
                        data-testid="relay-skill-menu-summary"
                      >
                        {skill.summary}
                      </span>
                    ) : null}
                    {!skill.compatible ? (
                      <span className="mt-0.5 line-clamp-1 text-xs text-destructive">
                        {skill.incompatibilities[0]?.message}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors group-focus:bg-muted/80"
                    data-testid="relay-skill-menu-toggle"
                  >
                    {selected.includes(skill.coordinate) ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                  </span>
                </DropdownMenuCheckboxItem>
              </RelaySkillPreviewButton>
            ))}
          </div>
          <Button asChild size="xs" variant="secondary">
            <DropdownMenuItem
              className="mx-1.5 mt-1 min-h-6 w-fit py-1"
              disabled={disabled}
              onSelect={openCreateEditor}
            >
              Create new
            </DropdownMenuItem>
          </Button>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <>
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-2">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor={labelFor}
        >
          {label}
        </label>
        {renderPickerIngress()}
      </div>
      <div
        className={cn(
          PERSONA_FIELD_SHELL_CLASS,
          "grid min-h-40 resize-y overflow-hidden",
          hasSelectedSkills && "[&_textarea]:pb-[3.25rem]",
        )}
        data-testid="relay-skill-picker-field"
      >
        <div className="col-start-1 row-start-1 min-h-0">{children}</div>
        {hasSelectedSkills ? (
          <div
            className="z-10 col-start-1 row-start-1 mr-6 flex max-h-20 flex-wrap items-center gap-1.5 self-end overflow-y-auto px-3 pb-2 pt-4"
            data-testid="relay-skill-picker-selected"
            style={{
              backgroundImage:
                "linear-gradient(to bottom, transparent 0, color-mix(in oklab, hsl(var(--muted)) 40%, hsl(var(--background))) 0.75rem)",
            }}
          >
            {selectedSkills.map((skill) => (
              <div
                className="flex h-7 max-w-full items-center rounded-full border border-border/70 bg-muted/35 pl-2.5 pr-1 text-xs text-foreground"
                key={skill.coordinate}
              >
                <RelaySkillPreviewButton
                  className="max-w-56 truncate"
                  onEdit={openEditEditor}
                  skill={skill}
                >
                  {skill.title || skill.slug}
                </RelaySkillPreviewButton>
                <button
                  aria-label={`Remove ${skill.title || skill.slug}`}
                  className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      selected.filter((value) => value !== skill.coordinate),
                    )
                  }
                  type="button"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {unknownSelected.map((coordinate) => (
              <div
                className="flex h-7 max-w-full items-center rounded-full border border-dashed border-border/70 pl-2.5 pr-1 text-xs text-muted-foreground"
                key={coordinate}
              >
                <span
                  className="max-w-56 truncate font-mono text-xs"
                  title="Instruction unavailable on this relay"
                >
                  Unavailable instruction
                </span>
                <button
                  aria-label="Remove unavailable instruction"
                  className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-muted hover:text-foreground"
                  disabled={disabled}
                  onClick={() =>
                    onChange(selected.filter((value) => value !== coordinate))
                  }
                  type="button"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {loadState === "error" ? (
        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-xs text-destructive">
            Shared instructions couldn’t be loaded.
          </p>
          <Button onClick={() => void loadSkills()} size="sm" variant="ghost">
            Try again
          </Button>
        </div>
      ) : null}
    </>
  );
}

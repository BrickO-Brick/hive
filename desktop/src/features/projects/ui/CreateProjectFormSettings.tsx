import { ChevronDown } from "lucide-react";

import { ChannelPermissionsSettings } from "@/features/channels/ui/ChannelPermissionsSettings";
import type { CreateProjectFormSettingsState } from "@/features/projects/ui/useCreateProjectFormSettings";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { cn } from "@/shared/lib/cn";

const NONE_AGENT_VALUE = "__none__";

const SETTINGS_ROW_CLASS =
  "flex min-h-12 items-center justify-between gap-4 rounded-xl border border-input bg-background px-3 py-3";

export function CreateProjectFormSettings({
  agentPersonaId,
  disabled,
  personas,
  projectVisibility,
  runtimesAvailable,
  setAgentPersonaId,
  setChannelVisibility,
  setProjectVisibility,
  channelVisibility,
}: CreateProjectFormSettingsState & { disabled: boolean }) {
  const selectedPersona = personas.find(
    (persona) => persona.id === agentPersonaId,
  );
  const listingLabel = projectVisibility === "unlisted" ? "Unlisted" : "Listed";
  const agentLabel = selectedPersona?.displayName ?? "None";
  const agentDisabled = disabled || (!runtimesAvailable && personas.length > 0);

  return (
    <>
      <ChannelPermissionsSettings
        disabled={disabled}
        onVisibilityChange={setChannelVisibility}
        testIdPrefix="create-project-channel"
        visibility={channelVisibility}
      />

      <div className={cn(SETTINGS_ROW_CLASS, disabled && "opacity-50")}>
        <span className="text-sm font-medium text-foreground">
          Project list
        </span>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Project list: ${listingLabel}`}
              className="-mr-2.5 ml-auto h-9 w-fit justify-end px-2.5 text-right text-sm font-medium text-foreground hover:bg-muted/50"
              data-testid="create-project-listing"
              disabled={disabled}
              type="button"
              variant="ghost"
            >
              <span className="text-right">{listingLabel}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground/70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => event.preventDefault()}
            style={{
              minWidth: "var(--radix-dropdown-menu-trigger-width)",
            }}
          >
            <DropdownMenuRadioGroup
              onValueChange={(value) =>
                setProjectVisibility(
                  value === "unlisted" ? "unlisted" : "listed",
                )
              }
              value={projectVisibility}
            >
              <DropdownMenuRadioItem
                data-testid="create-project-listing-option-listed"
                value="listed"
              >
                Listed
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                data-testid="create-project-listing-option-unlisted"
                value="unlisted"
              >
                Unlisted
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className={cn(SETTINGS_ROW_CLASS, agentDisabled && "opacity-50")}>
        <span className="text-sm font-medium text-foreground">
          Coding agent
        </span>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Coding agent: ${agentLabel}`}
              className="-mr-2.5 ml-auto h-9 min-w-0 max-w-[60%] justify-end px-2.5 text-right text-sm font-medium text-foreground hover:bg-muted/50"
              data-testid="create-project-agent"
              disabled={agentDisabled}
              type="button"
              variant="ghost"
            >
              <span className="truncate text-right">{agentLabel}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground/70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => event.preventDefault()}
            style={{
              minWidth: "var(--radix-dropdown-menu-trigger-width)",
            }}
          >
            <DropdownMenuRadioGroup
              onValueChange={(value) =>
                setAgentPersonaId(value === NONE_AGENT_VALUE ? "" : value)
              }
              value={agentPersonaId || NONE_AGENT_VALUE}
            >
              <DropdownMenuRadioItem
                data-testid="create-project-agent-option-none"
                value={NONE_AGENT_VALUE}
              >
                None
              </DropdownMenuRadioItem>
              {personas.map((persona) => (
                <DropdownMenuRadioItem
                  data-testid={`create-project-agent-option-${persona.id}`}
                  key={persona.id}
                  value={persona.id}
                >
                  {persona.displayName}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

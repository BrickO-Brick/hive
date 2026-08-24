import {
  CopyPlus,
  EllipsisVertical,
  Pencil,
  Rocket,
  Share2,
  Trash2,
} from "lucide-react";

import { resolveTeamPersonas } from "@/features/agents/lib/teamPersonas";
import type { AgentPersona, AgentTeam } from "@/shared/api/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { IdentityCardSkeleton } from "@/shared/ui/identity-card-skeleton";
import { SectionHeader } from "@/shared/ui/PageHeader";
import { CreateIdentityCard } from "./CreateIdentityCard";
import { TeamIdentityCard } from "./TeamIdentityCard";
import { IDENTITY_CARD_GRID_CLASS } from "./UnifiedAgentsSection";

const TEAM_CARD_COLUMN_CLASS = "w-full";

type TeamsSectionProps = {
  teams: AgentTeam[];
  personas: AgentPersona[];
  error: Error | null;
  isLoading: boolean;
  isPending: boolean;
  onCreate: () => void;
  onDuplicate: (team: AgentTeam) => void;
  onEdit: (team: AgentTeam) => void;
  onDelete: (team: AgentTeam) => void;
  onAddToChannel: (team: AgentTeam) => void;
  onShare: (team: AgentTeam) => void;
  onImport: () => void;
};

export function TeamsSection({
  teams,
  personas,
  error,
  isLoading,
  isPending,
  onCreate,
  onDuplicate,
  onEdit,
  onDelete,
  onAddToChannel,
  onShare,
  onImport,
}: TeamsSectionProps) {
  return (
    <section className="relative space-y-4" data-testid="agents-library-teams">
      <div className={TEAM_CARD_COLUMN_CLASS}>
        <SectionHeader
          title="Agent teams"
          description="Group agents that you can add to a channel together."
        />
      </div>

      {isLoading ? (
        <div className={IDENTITY_CARD_GRID_CLASS}>
          <IdentityCardSkeleton
            footerSubtitleWidthClass="w-14"
            footerTitleWidthClass="w-24"
            showAction
          />
          <IdentityCardSkeleton
            footerSubtitleWidthClass="w-24"
            footerTitleWidthClass="w-32"
            showAction
          />
          <IdentityCardSkeleton
            footerSubtitleWidthClass="w-20"
            footerTitleWidthClass="w-28"
            showAction
          />
        </div>
      ) : null}

      {!isLoading ? (
        <div className={IDENTITY_CARD_GRID_CLASS}>
          <NewTeamCard
            isPending={isPending}
            onCreate={onCreate}
            onImport={onImport}
          />
          {teams.map((team) => {
            const resolution = resolveTeamPersonas(team, personas);
            const missingPersonaCount = resolution.missingPersonaCount;
            const hasMissingPersonas = resolution.hasMissingPersonas;
            const isEmptyTeam = team.personaIds.length === 0;
            // The Deploy, Duplicate and Share items need a roster that has
            // members, and each member must be a known agent. The `isUsable`
            // flag shows both conditions. It is false if a member is not in My
            // Agents. It is also false if the team has no members.
            //
            // You must not share a team that has no members. The snapshot then
            // has no members, and the import of that snapshot fails with the
            // message "Team snapshot must have at least one member".
            //
            // The Edit and Delete items stay enabled. You use these two items
            // to delete a team: first remove all the members, then delete the
            // team.
            const canUseRoster = resolution.isUsable;

            return (
              <TeamIdentityCard
                actions={
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <button
                        aria-label={`${team.name} team actions`}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        type="button"
                      >
                        <EllipsisVertical className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onCloseAutoFocus={(event) => event.preventDefault()}
                    >
                      <DropdownMenuItem
                        disabled={isPending || !canUseRoster}
                        onClick={() => onAddToChannel(team)}
                      >
                        <Rocket className="h-4 w-4" />
                        Deploy to channel
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={isPending}
                        onClick={() => onEdit(team)}
                      >
                        <Pencil className="h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={isPending || !canUseRoster}
                        onClick={() => onDuplicate(team)}
                      >
                        <CopyPlus className="h-4 w-4" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={isPending || !canUseRoster}
                        onClick={() => onShare(team)}
                      >
                        <Share2 className="h-4 w-4" />
                        Share
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        disabled={isPending}
                        onClick={() => onDelete(team)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
                dataTestId={`team-card-${team.id}`}
                description={team.description}
                isSymlink={team.isSymlink}
                key={team.id}
                memberCount={team.personaIds.length}
                personas={resolution.resolvedPersonas}
                sourceDir={team.sourceDir}
                symlinkTarget={team.symlinkTarget}
                teamName={team.name}
                version={team.version}
              >
                {hasMissingPersonas ? (
                  <p className="border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {missingPersonaCount} agent
                    {missingPersonaCount === 1 ? "" : "s"} in this team{" "}
                    {missingPersonaCount === 1 ? "is" : "are"} no longer in your
                    agents. Edit the team to fix it before deploying or sharing.
                  </p>
                ) : null}
                {isEmptyTeam ? (
                  <p className="border-t border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    This team has no agents. Add one to deploy or share it, or
                    delete the team.
                  </p>
                ) : null}
              </TeamIdentityCard>
            );
          })}
        </div>
      ) : null}

      {error ? (
        <p
          className={`${TEAM_CARD_COLUMN_CLASS} rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive`}
        >
          {error.message}
        </p>
      ) : null}
    </section>
  );
}

function NewTeamCard({
  isPending,
  onCreate,
  onImport,
}: {
  isPending: boolean;
  onCreate: () => void;
  onImport: () => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <CreateIdentityCard ariaLabel="New team" dataTestId="new-team-card" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuItem disabled={isPending} onClick={onCreate}>
          Create team
        </DropdownMenuItem>
        <DropdownMenuItem disabled={isPending} onClick={onImport}>
          Import
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

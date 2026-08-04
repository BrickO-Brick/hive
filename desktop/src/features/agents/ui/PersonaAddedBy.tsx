import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { cn } from "@/shared/lib/cn";

type PersonaAddedByProps = {
  /** The adder's profile picture; omitted while the profile resolves. */
  avatarUrl?: string | null;
  className?: string;
  label?: string;
};

export function PersonaAddedBy({
  avatarUrl,
  className,
  label = "You",
}: PersonaAddedByProps) {
  return (
    <p
      className={cn(
        "flex min-w-0 items-center gap-1 text-xs leading-tight",
        className,
      )}
    >
      <span className="shrink-0 text-muted-foreground/55">Added by</span>
      <ProfileAvatar
        avatarUrl={avatarUrl ?? null}
        className="h-3.5 w-3.5 shrink-0 text-3xs"
        label={label}
      />
      <span className="truncate text-muted-foreground">{label}</span>
    </p>
  );
}

import { SmilePlus, X } from "lucide-react";
import * as React from "react";

import { EmojiPicker } from "@/features/custom-emoji/ui/EmojiPicker";
import { StatusEmoji } from "@/features/user-status/ui/StatusEmoji";
import { emojiDisplayName } from "@/shared/lib/emojiName";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

type WorkflowEmojiFieldProps = {
  ariaLabel: string;
  clearAriaLabel?: string;
  disabled?: boolean;
  id: string;
  onChange: (emoji: string | undefined) => void;
  value?: string;
};

export function WorkflowEmojiField({
  ariaLabel,
  clearAriaLabel,
  disabled,
  id,
  onChange,
  value,
}: WorkflowEmojiFieldProps) {
  const [pickerOpen, setPickerOpen] = React.useState(false);

  return (
    <div className="flex gap-2">
      <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-label={ariaLabel}
            className="flex-1 justify-start px-3 font-normal"
            disabled={disabled}
            id={id}
            type="button"
            variant="outline"
          >
            {value ? (
              <>
                <StatusEmoji className="h-5 w-5 text-base" value={value} />
                <span>{emojiDisplayName(value)}</span>
              </>
            ) : (
              <>
                <SmilePlus className="text-muted-foreground" />
                <span className="text-muted-foreground">Choose a reaction</span>
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-auto overflow-hidden rounded-2xl border-0 bg-transparent p-0 shadow-none"
          sideOffset={4}
        >
          <EmojiPicker
            autoFocus
            onSelect={(emoji) => {
              onChange(emoji);
              setPickerOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {value && clearAriaLabel ? (
        <Button
          aria-label={clearAriaLabel}
          disabled={disabled}
          onClick={() => onChange(undefined)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

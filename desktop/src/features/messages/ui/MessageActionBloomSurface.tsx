import { motion, useReducedMotion } from "motion/react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";

export const MESSAGE_ACTION_BLOOM_LAYOUT_ID = "message-action-bloom-surface";
export const MESSAGE_ACTION_BLOOM_EASE_OUT = [0.23, 1, 0.32, 1] as const;

const BLOOM_LAYOUT_SPRING = {
  type: "spring",
  stiffness: 400,
  damping: 28,
} as const;

type MessageActionBloomSurfaceProps = Omit<
  React.ComponentPropsWithoutRef<typeof motion.div>,
  "children"
> & {
  children?: React.ReactNode;
  contentClassName?: string;
  revealContent?: boolean;
  surfaceRadius?: number;
};

/**
 * The single visual shell shared by the message hover toolbar and each of its
 * expanded destinations. Motion pairs instances by layoutId, so the toolbar
 * itself appears to change shape instead of spawning a second surface above it.
 */
export const MessageActionBloomSurface = React.forwardRef<
  HTMLDivElement,
  MessageActionBloomSurfaceProps
>(function MessageActionBloomSurface(
  {
    children,
    className,
    contentClassName,
    revealContent = true,
    surfaceRadius = 12,
    style,
    ...props
  },
  ref,
) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className={cn(
        "overflow-hidden border border-border/70 bg-background/95 shadow-xs backdrop-blur-sm supports-[backdrop-filter]:bg-background/85",
        className,
      )}
      layoutId={MESSAGE_ACTION_BLOOM_LAYOUT_ID}
      ref={ref}
      style={{ ...style, borderRadius: surfaceRadius }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : {
              layout: BLOOM_LAYOUT_SPRING,
            }
      }
      {...props}
    >
      {revealContent ? (
        <motion.div
          animate={{ opacity: 1 }}
          className={contentClassName}
          initial={{ opacity: 0 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : {
                  delay: 0.08,
                  duration: 0.14,
                  ease: MESSAGE_ACTION_BLOOM_EASE_OUT,
                }
          }
        >
          {children}
        </motion.div>
      ) : (
        children
      )}
    </motion.div>
  );
});

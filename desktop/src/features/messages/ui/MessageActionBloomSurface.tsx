import { motion, useReducedMotion } from "motion/react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";

export const MESSAGE_ACTION_BLOOM_LAYOUT_ID = "message-action-bloom-surface";
export const MESSAGE_ACTION_BLOOM_EASE_OUT = [0.23, 1, 0.32, 1] as const;

const BLOOM_LAYOUT_TRANSITION = {
  duration: 0.24,
  ease: MESSAGE_ACTION_BLOOM_EASE_OUT,
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
  const [contentReady, setContentReady] = React.useState(
    reduceMotion || !revealContent,
  );

  React.useEffect(() => {
    if (reduceMotion || !revealContent) {
      setContentReady(true);
      return;
    }

    // Radix positions portalled content after it mounts. Keep the destination
    // content out of sight through that measurement and the first part of the
    // shell morph; the callback below normally wins, while this is a safety net
    // for browsers that skip layout-complete notifications.
    const fallback = window.setTimeout(() => setContentReady(true), 160);
    return () => window.clearTimeout(fallback);
  }, [reduceMotion, revealContent]);

  return (
    <motion.div
      className={cn(
        "overflow-hidden border border-border/70 bg-background/95 shadow-xs backdrop-blur-sm supports-[backdrop-filter]:bg-background/85",
        className,
      )}
      layoutId={MESSAGE_ACTION_BLOOM_LAYOUT_ID}
      onLayoutAnimationComplete={() => setContentReady(true)}
      ref={ref}
      style={{ ...style, borderRadius: surfaceRadius }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : {
              layout: BLOOM_LAYOUT_TRANSITION,
            }
      }
      {...props}
    >
      {revealContent ? (
        <motion.div
          animate={{ opacity: contentReady ? 1 : 0 }}
          className={contentClassName}
          initial={{ opacity: 0 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : {
                  duration: 0.12,
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

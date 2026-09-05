import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { HiveNavigation, type HiveNavigationProps } from "./HiveNavigation";

const STATE_STORAGE_KEY = "hive.navigation.collapsed.v1";
const WIDTH_STORAGE_KEY = "hive.navigation.width.v1";
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 260;
const MAX_WIDTH = 440;
const KEYBOARD_STEP = 16;

type Props = Omit<HiveNavigationProps, "collapsed" | "mobile" | "onToggle">;

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

function initialWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0
    ? clampWidth(stored)
    : DEFAULT_WIDTH;
}

function initiallyCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(STATE_STORAGE_KEY);
  if (stored !== null) return stored === "true";
  return window.innerWidth >= 768 && window.innerWidth < 1024;
}

export function HiveResizableNavigation(props: Props) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const [width, setWidth] = useState(initialWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ pointerX: number; width: number } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(STATE_STORAGE_KEY, String(collapsed));
  }, [collapsed]);
  useEffect(() => {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  const resize = (event: PointerEvent<HTMLHRElement>) => {
    const start = resizeStart.current;
    if (start)
      setWidth(clampWidth(start.width + event.clientX - start.pointerX));
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLHRElement>) => {
    const next = {
      ArrowLeft: width - KEYBOARD_STEP,
      ArrowRight: width + KEYBOARD_STEP,
      Home: MIN_WIDTH,
      End: MAX_WIDTH,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setWidth(clampWidth(next));
  };
  const finishResize = (element?: HTMLHRElement, pointerId?: number) => {
    resizeStart.current = null;
    if (
      element &&
      pointerId !== undefined &&
      element.hasPointerCapture(pointerId)
    ) {
      element.releasePointerCapture(pointerId);
    }
    setResizing(false);
  };

  return (
    <aside
      data-testid="desktop-navigation"
      className={`relative z-20 hidden shrink-0 flex-col border-r border-[#D8DEE8] bg-white md:flex ${
        resizing ? "" : "transition-[width] duration-150"
      }`}
      style={{ width: collapsed ? 68 : width }}
    >
      <HiveNavigation
        {...props}
        collapsed={collapsed}
        onToggle={() => setCollapsed((current) => !current)}
      />
      {!collapsed && (
        <hr
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          data-testid="navigation-resize-handle"
          onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={(event) => {
            resizeStart.current = { pointerX: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          onPointerMove={resize}
          onPointerUp={(event) =>
            finishResize(event.currentTarget, event.pointerId)
          }
          onPointerCancel={() => finishResize()}
          onLostPointerCapture={() => finishResize()}
          className="absolute top-0 -right-1.5 z-20 m-0 h-full w-3 cursor-col-resize touch-none border-0 bg-transparent outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition hover:after:bg-[#2F6FED] focus-visible:after:bg-[#2F6FED]"
          title="Drag to resize navigation. Double-click to reset."
        />
      )}
    </aside>
  );
}

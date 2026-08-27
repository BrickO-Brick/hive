"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, Plus, Search, SquareDashed, X } from "lucide-react";
import { ProjectArtifactRenderer } from "./berd-project-cube/ProjectArtifactRenderer";
import type {
  ProjectArtifactProjection,
  ProjectArtifactState,
} from "./berd-project-cube/types";

const PRIMARY_PROJECT_STATE: ProjectArtifactState = {
  seed: 381,
  name: "Buzz navigation",
  accentColor: "#b8d9ca",
  accentCssColor: "#b8d9ca",
  mood: "active",
  moodIntensity: 0.72,
  contentMode: "cube",
};

const SECONDARY_PROJECT_STATE: ProjectArtifactState = {
  seed: 734,
  name: "Agent workspace",
  accentColor: "#d8ca94",
  accentCssColor: "#d8ca94",
  mood: "energetic",
  moodIntensity: 0.68,
  contentMode: "cube",
};

const TERTIARY_PROJECT_STATE: ProjectArtifactState = {
  seed: 912,
  name: "Blue sky prototype",
  accentColor: "#27a9eb",
  accentCssColor: "#27a9eb",
  mood: "active",
  moodIntensity: 0.76,
  contentMode: "cube",
};

const RELAY_PROJECT_STATE: ProjectArtifactState = {
  seed: 144,
  name: "Relay handoffs",
  accentColor: "#e38b6e",
  accentCssColor: "#e38b6e",
  mood: "energetic",
  moodIntensity: 0.7,
  contentMode: "cube",
};

const ATLAS_PROJECT_STATE: ProjectArtifactState = {
  seed: 626,
  name: "Atlas research",
  accentColor: "#9d8bea",
  accentCssColor: "#9d8bea",
  mood: "active",
  moodIntensity: 0.66,
  contentMode: "cube",
};

const LANTERN_PROJECT_STATE: ProjectArtifactState = {
  seed: 508,
  name: "Lantern launch",
  accentColor: "#78b98c",
  accentCssColor: "#78b98c",
  mood: "active",
  moodIntensity: 0.74,
  contentMode: "cube",
};

const PRIMARY_IMAGE_URLS = ["/berd-project-assets/memory-03.webp"];
const SECONDARY_IMAGE_URLS = ["/berd-project-assets/memory-17.webp"];
const TERTIARY_IMAGE_URLS = ["/berd-project-assets/memory-35.webp"];

type TaskNoodle = {
  avatar: string;
  label: string;
  id: string;
  context: string;
  created: string;
  assignee: string;
};
type ProjectTasks = readonly [TaskNoodle, TaskNoodle, TaskNoodle];

type SelectedTask = {
  projectKey: string;
  projectName: string;
  accentColor: string;
  task: TaskNoodle;
  taskIndex: number;
};

const COMMON_TASK_DETAILS = {
  created: "Aug 26, 2026",
  assignee: "Cynthia Chen",
};

const PRIMARY_TASKS: ProjectTasks = [
  { avatar: "/berd-agent-avatars/pushback-gloopies-5.png", label: "GIF support", id: "BUZZ-1892", context: "Add dependable animated GIF playback and previews throughout project conversations, including clear loading and failure states.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/builderbot-gloopies-20.png", label: "Nav polish", id: "BUZZ-1904", context: "Refine the primary navigation spacing, selected states, and responsive behavior so it stays quiet and legible.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/berdy-gloopies-22.png", label: "Review PR-381", id: "BUZZ-381", context: "Review the project workspace changes, check the interaction details, and leave actionable feedback before merge.", ...COMMON_TASK_DETAILS },
];

const SECONDARY_TASKS: ProjectTasks = [
  { avatar: "/berd-agent-avatars/berdy-gloopies-22.png", label: "Agent CLI", id: "AGENT-214", context: "Prototype a compact command-line workflow for launching and inspecting workspace agents.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/pushback-gloopies-5.png", label: "Team astrology", id: "AGENT-227", context: "Explore a playful team activity that turns project signals into a lightweight weekly reading.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/builderbot-gloopies-20.png", label: "Run QA", id: "AGENT-231", context: "Exercise the key workspace flows and record any interaction or rendering regressions.", ...COMMON_TASK_DETAILS },
];

const TERTIARY_TASKS: ProjectTasks = [
  { avatar: "/berd-agent-avatars/builderbot-gloopies-20.png", label: "Prototype CLI", id: "BLUE-104", context: "Build the smallest useful prototype for the new project command-line experience.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/berdy-gloopies-22.png", label: "Motion study", id: "BLUE-118", context: "Tune the hover, focus, and transition motion so the project objects feel physical but controlled.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/pushback-gloopies-5.png", label: "Ship demo", id: "BLUE-125", context: "Prepare the prototype for a focused internal demonstration and collect follow-up questions.", ...COMMON_TASK_DETAILS },
];

const RELAY_TASKS: readonly TaskNoodle[] = [
  { avatar: "/berd-agent-avatars/pushback-gloopies-5.png", label: "Handoff timeline", id: "RELAY-42", context: "Make agent-to-agent handoffs readable as a single chronological thread with clear ownership changes.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/berdy-gloopies-22.png", label: "Retry states", id: "RELAY-57", context: "Design recoverable retry states for interrupted handoffs without duplicating completed work.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/builderbot-gloopies-20.png", label: "Connection audit", id: "RELAY-63", context: "Audit connection health signals and surface the smallest useful status summary for each relay.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/pushback-gloopies-5.png", label: "Latency budget", id: "RELAY-71", context: "Set a practical latency budget for each handoff stage and identify the slowest transitions.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/berdy-gloopies-22.png", label: "Owner fallback", id: "RELAY-79", context: "Define who takes over when the assigned agent becomes unavailable during an active relay.", ...COMMON_TASK_DETAILS },
];

const ATLAS_TASKS: readonly TaskNoodle[] = [
  { avatar: "/berd-agent-avatars/builderbot-gloopies-20.png", label: "Source map", id: "ATLAS-88", context: "Map the research sources behind project decisions and show where each conclusion originated.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/pushback-gloopies-5.png", label: "Insight clusters", id: "ATLAS-96", context: "Group related findings into concise themes while preserving links back to the original evidence.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/berdy-gloopies-22.png", label: "Weekly digest", id: "ATLAS-103", context: "Generate a lightweight weekly digest of new findings, open questions, and changed assumptions.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/builderbot-gloopies-20.png", label: "Archive sources", id: "ATLAS-111", context: "Archive stale references while retaining a clear trail for decisions that still depend on them.", ...COMMON_TASK_DETAILS },
];

const LANTERN_TASKS: readonly TaskNoodle[] = [
  { avatar: "/berd-agent-avatars/berdy-gloopies-22.png", label: "Launch checklist", id: "LANTERN-12", context: "Turn the launch plan into a shared checklist with owners, dependencies, and confidence signals.", ...COMMON_TASK_DETAILS },
  { avatar: "/berd-agent-avatars/builderbot-gloopies-20.png", label: "Audience notes", id: "LANTERN-19", context: "Collect audience-specific talking points and keep the latest approved narrative easy to find.", ...COMMON_TASK_DETAILS },
];

const GOOSE_PROJECT_TASKS: readonly TaskNoodle[] = [
  ...SECONDARY_TASKS,
  { avatar: "/berd-agent-avatars/pushback-gloopies-5.png", label: "Prompt presets", id: "AGENT-244", context: "Create reusable prompt presets for the most common workspace agent workflows.", ...COMMON_TASK_DETAILS },
];

const BUZZ_PROJECT_TASKS: readonly TaskNoodle[] = TERTIARY_TASKS.slice(0, 2);

type ProjectDefinition = {
  key: string;
  name: string;
  state: ProjectArtifactState;
  imageUrls: string[];
  tasks: readonly TaskNoodle[];
};

const PROJECTS: readonly ProjectDefinition[] = [
  { key: "berd", name: "Berd", state: PRIMARY_PROJECT_STATE, imageUrls: PRIMARY_IMAGE_URLS, tasks: PRIMARY_TASKS },
  { key: "goose", name: "Goose", state: SECONDARY_PROJECT_STATE, imageUrls: SECONDARY_IMAGE_URLS, tasks: GOOSE_PROJECT_TASKS },
  { key: "buzz", name: "Buzz", state: TERTIARY_PROJECT_STATE, imageUrls: TERTIARY_IMAGE_URLS, tasks: BUZZ_PROJECT_TASKS },
  { key: "relay", name: "Relay", state: RELAY_PROJECT_STATE, imageUrls: SECONDARY_IMAGE_URLS, tasks: RELAY_TASKS },
  { key: "atlas", name: "Atlas", state: ATLAS_PROJECT_STATE, imageUrls: TERTIARY_IMAGE_URLS, tasks: ATLAS_TASKS },
  { key: "lantern", name: "Lantern", state: LANTERN_PROJECT_STATE, imageUrls: PRIMARY_IMAGE_URLS, tasks: LANTERN_TASKS },
];

type LabelMotion = {
  projection: ProjectArtifactProjection;
  reduceMotion: boolean;
};

type NoodlePoint = { x: number; y: number };
const NOODLE_STROKE_WIDTH = 60;
const MIN_NOODLE_PADDING = 1;
const NOODLE_CUBE_GAP = 26;
const NOODLE_TEXT_OFFSET = 62;
const NOODLE_TRAILING_PADDING = 4;

function signedArea(points: NoodlePoint[]) {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function resampleClosedContour(points: NoodlePoint[], count: number) {
  if (points.length < 2) return points;
  const ordered = signedArea(points) >= 0 ? points : [...points].reverse();
  const lengths = [0];
  for (let index = 0; index < ordered.length; index += 1) {
    const point = ordered[index];
    const next = ordered[(index + 1) % ordered.length];
    lengths.push(lengths[lengths.length - 1] + Math.hypot(next.x - point.x, next.y - point.y));
  }
  const perimeter = lengths[lengths.length - 1];
  const samples: NoodlePoint[] = [];
  let edge = 0;
  for (let sample = 0; sample < count; sample += 1) {
    const distance = (sample / count) * perimeter;
    while (edge < ordered.length - 1 && lengths[edge + 1] < distance) edge += 1;
    const start = ordered[edge];
    const end = ordered[(edge + 1) % ordered.length];
    const edgeLength = lengths[edge + 1] - lengths[edge] || 1;
    const progress = (distance - lengths[edge]) / edgeLength;
    samples.push({
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress,
    });
  }

  const minY = Math.min(...samples.map((point) => point.y));
  const minX = Math.min(...samples.map((point) => point.x));
  const maxX = Math.max(...samples.map((point) => point.x));
  const topCenter = { x: (minX + maxX) / 2, y: minY };
  const startIndex = samples.reduce((best, point, index) =>
    Math.hypot(point.x - topCenter.x, point.y - topCenter.y) <
    Math.hypot(samples[best].x - topCenter.x, samples[best].y - topCenter.y)
      ? index
      : best,
  0);
  return samples.slice(startIndex).concat(samples.slice(0, startIndex));
}

function offsetContour(points: NoodlePoint[], distance: number) {
  const clockwise = signedArea(points) >= 0;
  const edgeNormal = (from: NoodlePoint, to: NoodlePoint) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    return clockwise
      ? { x: dy / length, y: -dx / length }
      : { x: -dy / length, y: dx / length };
  };
  return points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const beforeNormal = edgeNormal(previous, point);
    const afterNormal = edgeNormal(point, next);
    const sumX = beforeNormal.x + afterNormal.x;
    const sumY = beforeNormal.y + afterNormal.y;
    const sumLength = Math.hypot(sumX, sumY) || 1;
    const normal = { x: sumX / sumLength, y: sumY / sumLength };
    const projection = Math.max(
      0.67,
      normal.x * afterNormal.x + normal.y * afterNormal.y,
    );
    const miter = Math.min(distance * 1.45, distance / projection);
    return { x: point.x + normal.x * miter, y: point.y + normal.y * miter };
  });
}

function contourRangeByLength(
  points: NoodlePoint[],
  start: number,
  targetLength: number,
  direction: 1 | -1,
) {
  const startIndex = Math.round(start * points.length) % points.length;
  const range = [points[startIndex]];
  let index = startIndex;
  let traversed = 0;
  while (range.length <= points.length && traversed < targetLength) {
    const nextIndex = (index + direction + points.length) % points.length;
    const point = points[index];
    const next = points[nextIndex];
    const segmentLength = Math.hypot(next.x - point.x, next.y - point.y) || 1;
    if (traversed + segmentLength >= targetLength) {
      const progress = (targetLength - traversed) / segmentLength;
      range.push({
        x: point.x + (next.x - point.x) * progress,
        y: point.y + (next.y - point.y) * progress,
      });
      break;
    }
    traversed += segmentLength;
    index = nextIndex;
    range.push(next);
  }
  return range;
}

function closedContourLength(points: NoodlePoint[]) {
  return points.reduce((length, point, index) => {
    const next = points[(index + 1) % points.length];
    return length + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0);
}

function smoothPath(points: NoodlePoint[]) {
  if (points.length < 2) return "";
  const commands = [`M ${points[0].x} ${points[0].y}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const after = points[Math.min(points.length - 1, index + 2)];
    const controlOne = {
      x: current.x + (next.x - before.x) / 6,
      y: current.y + (next.y - before.y) / 6,
    };
    const controlTwo = {
      x: next.x - (after.x - current.x) / 6,
      y: next.y - (after.y - current.y) / 6,
    };
    commands.push(
      `C ${controlOne.x} ${controlOne.y}, ${controlTwo.x} ${controlTwo.y}, ${next.x} ${next.y}`,
    );
  }
  return commands.join(" ");
}

function WrappedTaskLabels({
  motion,
  tasks,
  accentColor,
  selectedIndex,
  onSelect,
}: {
  motion: MutableRefObject<LabelMotion>;
  tasks: ProjectTasks;
  accentColor: string;
  selectedIndex: number | null;
  onSelect: (taskIndex: number) => void;
}) {
  const pathId = useId().replace(/:/g, "");
  const supportPathId = `${pathId}-support`;
  const navPathId = `${pathId}-nav`;
  const reviewPathId = `${pathId}-review`;
  const supportPathRef = useRef<SVGPathElement>(null);
  const navPathRef = useRef<SVGPathElement>(null);
  const reviewPathRef = useRef<SVGPathElement>(null);
  const supportAvatarRef = useRef<SVGImageElement>(null);
  const navAvatarRef = useRef<SVGImageElement>(null);
  const reviewAvatarRef = useRef<SVGImageElement>(null);
  const supportTextRef = useRef<SVGTextElement>(null);
  const navTextRef = useRef<SVGTextElement>(null);
  const reviewTextRef = useRef<SVGTextElement>(null);
  const smoothedTraceRef = useRef<NoodlePoint[] | null>(null);
  const liveTraceRef = useRef<NoodlePoint[]>([]);
  const taskStartOverridesRef = useRef<Array<number | null>>([null, null, null]);
  const dragRef = useRef<{
    index: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const projection = motion.current.projection;
      const left = 55 + projection.x;
      const top = 35 + projection.y;
      const right = left + projection.width;
      const bottom = top + projection.height;
      const width = projection.width;
      const height = projection.height;
      const contour = projection.contour?.map((point) => ({
        x: point.x + 55,
        y: point.y + 35,
      }));

      if (contour && contour.length >= 4) {
        const targetTrace = offsetContour(
          resampleClosedContour(contour, 160),
          NOODLE_STROKE_WIDTH / 2 + NOODLE_CUBE_GAP,
        );
        if (!smoothedTraceRef.current || smoothedTraceRef.current.length !== targetTrace.length) {
          smoothedTraceRef.current = targetTrace.map((point) => ({ ...point }));
        } else {
          const blend = motion.current.reduceMotion ? 1 : 0.52;
          smoothedTraceRef.current.forEach((point, index) => {
            point.x += (targetTrace[index].x - point.x) * blend;
            point.y += (targetTrace[index].y - point.y) * blend;
          });
        }
        const trace = smoothedTraceRef.current;
        liveTraceRef.current = trace;
        const perimeter = closedContourLength(trace);
        // Rounded stroke caps each consume half the stroke width. Keep a small
        // sampling cushion while allowing the task noodles to sit more tightly.
        const minimumGapFraction =
          (NOODLE_STROKE_WIDTH + MIN_NOODLE_PADDING) / perimeter;
        const topGap = Math.max(0.02, minimumGapFraction);
        // The two left-side noodles meet near a broad projected corner, so the
        // same perimeter distance reads much larger than the top seam.
        const leftGap = Math.max(0.012, minimumGapFraction * 0.58);
        const defaultSupportStart = 0.82;
        const supportStart = taskStartOverridesRef.current[0] ?? defaultSupportStart;
        const navStart = taskStartOverridesRef.current[1] ?? topGap / 2;
        const reviewStart =
          taskStartOverridesRef.current[2] ?? defaultSupportStart - leftGap;
        const noodleLength = (text: SVGTextElement | null, fallback: number) =>
          NOODLE_TEXT_OFFSET +
          (text?.getComputedTextLength() || fallback) +
          NOODLE_TRAILING_PADDING;

        supportPathRef.current?.setAttribute(
          "d",
          smoothPath(
            contourRangeByLength(
              trace,
              supportStart,
              noodleLength(supportTextRef.current, 118),
              1,
            ),
          ),
        );
        navPathRef.current?.setAttribute(
          "d",
          smoothPath(
            contourRangeByLength(
              trace,
              navStart,
              noodleLength(navTextRef.current, 112),
              1,
            ),
          ),
        );
        reviewPathRef.current?.setAttribute(
          "d",
          smoothPath(
            contourRangeByLength(
              trace,
              reviewStart,
              noodleLength(reviewTextRef.current, 174),
              -1,
            ),
          ),
        );
      } else {
        const margin = Math.max(28, Math.min(width, height) * 0.085);
        const topY = top - margin;
        const leftX = left - margin;
        const rightX = right + margin;
        const bottomY = bottom + margin;
        supportPathRef.current?.setAttribute(
          "d",
          `M ${left + width * 0.43} ${topY} C ${left + width * 0.1} ${topY}, ${leftX} ${top + height * 0.08}, ${leftX} ${top + height * 0.48}`,
        );
        navPathRef.current?.setAttribute(
          "d",
          `M ${left + width * 0.55} ${topY} C ${right - width * 0.08} ${topY}, ${rightX} ${top + height * 0.04}, ${rightX} ${top + height * 0.4}`,
        );
        reviewPathRef.current?.setAttribute(
          "d",
          `M ${leftX} ${top + height * 0.56} C ${leftX} ${bottom - height * 0.08}, ${left + width * 0.06} ${bottomY}, ${left + width * 0.58} ${bottomY}`,
        );
      }

      const placeAvatar = (
        path: SVGPathElement | null,
        avatar: SVGImageElement | null,
        distanceFromStart: number,
      ) => {
        if (!path || !avatar) return;
        const length = path.getTotalLength();
        const point = path.getPointAtLength(
          Math.min(length, distanceFromStart),
        );
        const nextPoint = path.getPointAtLength(
          Math.min(length, distanceFromStart + 2),
        );
        const angle =
          (Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x) * 180) /
          Math.PI;
        const size = 46;
        avatar.setAttribute("x", String(point.x - size / 2));
        avatar.setAttribute("y", String(point.y - size / 2));
        avatar.setAttribute("width", String(size));
        avatar.setAttribute("height", String(size));
        avatar.setAttribute(
          "transform",
          `rotate(${angle} ${point.x} ${point.y})`,
        );
      };

      placeAvatar(supportPathRef.current, supportAvatarRef.current, 22);
      placeAvatar(navPathRef.current, navAvatarRef.current, 22);
      placeAvatar(reviewPathRef.current, reviewAvatarRef.current, 22);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [motion]);

  const moveTaskToPointer = (
    event: ReactPointerEvent<SVGGElement>,
    taskIndex: number,
  ) => {
    const svg = event.currentTarget.ownerSVGElement;
    const trace = liveTraceRef.current;
    if (!svg || trace.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * 760;
    const y = ((event.clientY - rect.top) / rect.height) * 720;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    trace.forEach((point, index) => {
      const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    taskStartOverridesRef.current[taskIndex] = nearestIndex / trace.length;
  };

  const beginTaskDrag = (
    event: ReactPointerEvent<SVGGElement>,
    taskIndex: number,
  ) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      index: taskIndex,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    setDraggingIndex(taskIndex);
  };

  const updateTaskDrag = (
    event: ReactPointerEvent<SVGGElement>,
    taskIndex: number,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.index !== taskIndex) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
      drag.moved = true;
    }
    if (drag.moved) moveTaskToPointer(event, taskIndex);
  };

  const endTaskDrag = (
    event: ReactPointerEvent<SVGGElement>,
    taskIndex: number,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.index !== taskIndex) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDraggingIndex(null);
    if (!drag.moved) onSelect(taskIndex);
  };

  return (
    <svg className="wrapped-labels" viewBox="0 0 760 720" role="group" aria-label="Tasks wrapped around the project cube">
        <defs>
          <path ref={supportPathRef} id={supportPathId} d="M 270 119 C 148 108, 91 184, 79 310" />
          <path ref={navPathRef} id={navPathId} d="M 354 111 C 500 91, 604 132, 608 251" />
          <path ref={reviewPathRef} id={reviewPathId} d="M 89 440 C 96 575, 191 646, 352 641" />
        </defs>
        {[
          { task: tasks[0], pathId: supportPathId, avatarRef: supportAvatarRef, textRef: supportTextRef, className: "support-ribbon" },
          { task: tasks[1], pathId: navPathId, avatarRef: navAvatarRef, textRef: navTextRef, className: "nav-ribbon" },
          { task: tasks[2], pathId: reviewPathId, avatarRef: reviewAvatarRef, textRef: reviewTextRef, className: "review-ribbon" },
        ].map(({ task, pathId: taskPathId, avatarRef, textRef, className }, index) => (
          <g
            key={task.id}
            className={`label-ribbon ${className}${selectedIndex === index ? " is-selected" : ""}${draggingIndex === index ? " is-dragging" : ""}`}
            style={{ "--task-accent": accentColor } as CSSProperties}
            role="button"
            tabIndex={0}
            aria-label={`Open ${task.label}`}
            aria-pressed={selectedIndex === index}
            onPointerDown={(event) => beginTaskDrag(event, index)}
            onPointerMove={(event) => updateTaskDrag(event, index)}
            onPointerUp={(event) => endTaskDrag(event, index)}
            onPointerCancel={(event) => endTaskDrag(event, index)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(index);
              }
            }}
          >
            <use href={`#${taskPathId}`} className="noodle-hit-area" />
            <use href={`#${taskPathId}`} className="ribbon-stroke" />
            <image ref={avatarRef} className="noodle-avatar" href={task.avatar} preserveAspectRatio="xMidYMid meet" />
            <text ref={textRef} className="ribbon-text"><textPath href={`#${taskPathId}`} startOffset={NOODLE_TEXT_OFFSET}>{task.label}</textPath></text>
          </g>
        ))}
    </svg>
  );
}

function ProjectOrbit({
  projectKey,
  displayName,
  className,
  imageUrls,
  state,
  tasks,
  selectedTask,
  onSelectTask,
}: {
  projectKey: string;
  displayName: string;
  className: string;
  imageUrls: string[];
  state: ProjectArtifactState;
  tasks: ProjectTasks;
  selectedTask: SelectedTask | null;
  onSelectTask: (selection: SelectedTask) => void;
}) {
  const motion = useRef<LabelMotion>({
    projection: { x: 145, y: 135, width: 280, height: 300 },
    reduceMotion: false,
  });
  const projectNamePillRef = useRef<HTMLDivElement>(null);
  const [cubeHovered, setCubeHovered] = useState(false);
  const isSelectedProject = selectedTask?.projectKey === projectKey;
  const isDimmed = Boolean(selectedTask && !isSelectedProject);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { motion.current.reduceMotion = query.matches; };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <div
      className={`orbit-system ${className}${isSelectedProject ? " is-selected-project" : ""}${isDimmed ? " is-dimmed" : ""}`}
      aria-label={`${state.name} project`}
    >
      <WrappedTaskLabels
        motion={motion}
        tasks={tasks}
        accentColor={state.accentCssColor}
        selectedIndex={isSelectedProject ? selectedTask.taskIndex : null}
        onSelect={(taskIndex) => {
          onSelectTask({
            projectKey,
            projectName: displayName,
            accentColor: state.accentCssColor,
            task: tasks[taskIndex],
            taskIndex,
          });
        }}
      />
      <div
        className="canvas-wrap"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const projection = motion.current.projection;
          const x = ((event.clientX - rect.left) / rect.width) * 650;
          const y = ((event.clientY - rect.top) / rect.height) * 650;
          setCubeHovered(
            x >= projection.x &&
            x <= projection.x + projection.width &&
            y >= projection.y &&
            y <= projection.y + projection.height,
          );
        }}
        onPointerLeave={() => setCubeHovered(false)}
      >
        <ProjectArtifactRenderer
          state={state}
          imageUrls={imageUrls}
          environmentUrl="/berd-project-assets/studio_soft.exr"
          variant="tile"
          cameraDistanceScale={1.35}
          focusSide={isSelectedProject}
          onCubeProjection={(projection) => {
            motion.current.projection = projection;
            if (projectNamePillRef.current) {
              projectNamePillRef.current.style.left = `${55 + projection.x + projection.width / 2}px`;
              projectNamePillRef.current.style.top = `${35 + projection.y + projection.height - 42}px`;
            }
          }}
        />
      </div>
      <div
        ref={projectNamePillRef}
        className={`project-name-pill${cubeHovered ? " is-visible" : ""}`}
        aria-hidden="true"
      >
        {displayName}
      </div>
    </div>
  );
}

function ProjectsView() {
  const [activeProjectIndex, setActiveProjectIndex] = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const carouselRowRef = useRef<HTMLDivElement>(null);
  const carouselDragRef = useRef<{
    pointerId: number;
    startX: number;
    lastX: number;
    moved: boolean;
  } | null>(null);
  const activeProject = PROJECTS[activeProjectIndex];

  useEffect(() => {
    setExpandedTaskId(null);
  }, [activeProjectIndex]);

  const offsetForProject = (projectIndex: number) => {
    let offset = projectIndex - activeProjectIndex;
    const midpoint = PROJECTS.length / 2;
    if (offset > midpoint) offset -= PROJECTS.length;
    if (offset < -midpoint) offset += PROJECTS.length;
    return offset;
  };

  const selectPreviousProject = () => {
    setActiveProjectIndex((index) => (index - 1 + PROJECTS.length) % PROJECTS.length);
  };

  const selectNextProject = () => {
    setActiveProjectIndex((index) => (index + 1) % PROJECTS.length);
  };

  const beginCarouselDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    carouselDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      moved: false,
    };
    carouselRowRef.current?.classList.add("is-dragging");
  };

  const updateCarouselDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = carouselDragRef.current;
    const row = carouselRowRef.current;
    if (!drag || !row || drag.pointerId !== event.pointerId) return;
    drag.lastX = event.clientX;
    const rawDelta = drag.lastX - drag.startX;
    if (Math.abs(rawDelta) > 5) drag.moved = true;
    const delta = Math.max(-row.clientWidth * 0.34, Math.min(row.clientWidth * 0.34, rawDelta));
    row.style.setProperty("--carousel-drag-x", `${delta}px`);
  };

  const endCarouselDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    const drag = carouselDragRef.current;
    const row = carouselRowRef.current;
    if (!drag || !row || drag.pointerId !== event.pointerId) return;
    const delta = drag.lastX - drag.startX;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    carouselDragRef.current = null;
    row.classList.remove("is-dragging");

    if (!cancelled && Math.abs(delta) >= 64) {
      if (delta < 0) selectNextProject();
      else selectPreviousProject();
    } else if (!cancelled && !drag.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      const position = (event.clientX - rect.left) / rect.width;
      if (position < 0.34) selectPreviousProject();
      if (position > 0.66) selectNextProject();
    }

    requestAnimationFrame(() => {
      row.style.setProperty("--carousel-drag-x", "0px");
    });
  };

  return (
    <section className="projects-stage" aria-label="Projects">
      <div ref={carouselRowRef} className="projects-cube-row" aria-label="Project carousel">
        {PROJECTS.map((project, projectIndex) => {
          const offset = offsetForProject(projectIndex);
          const slot = offset === 0 ? "active" : Math.abs(offset) === 1 ? "neighbor" : "far";
          return (
            <div
              key={project.key}
              className={`projects-gallery-item slot-${slot}`}
              style={{ left: `${50 + offset * 50}%` }}
              aria-hidden="true"
            >
              <ProjectArtifactRenderer
                state={project.state}
                imageUrls={project.imageUrls}
                environmentUrl="/berd-project-assets/studio_soft.exr"
                variant="tile"
                cameraDistanceScale={1.35}
              />
            </div>
          );
        })}
        <div
          className="projects-carousel-drag-surface"
          role="slider"
          tabIndex={0}
          aria-label="Select project"
          aria-valuemin={1}
          aria-valuemax={PROJECTS.length}
          aria-valuenow={activeProjectIndex + 1}
          aria-valuetext={activeProject.name}
          onPointerDown={beginCarouselDrag}
          onPointerMove={updateCarouselDrag}
          onPointerUp={(event) => endCarouselDrag(event)}
          onPointerCancel={(event) => endCarouselDrag(event, true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              selectPreviousProject();
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              selectNextProject();
            }
          }}
        />
      </div>

      <section className="projects-info" aria-live="polite">
        <div className="projects-info-heading">
          <button type="button" className="projects-filter">My tasks <ChevronDown aria-hidden="true" size={18} strokeWidth={1.75} /></button>
          <span className="projects-active-name">{activeProject.name}</span>
        </div>

        <div className="projects-task-list">
          {activeProject.tasks.map((task) => {
            const isExpanded = expandedTaskId === task.id;
            return (
              <article
                key={task.id}
                className={`projects-task-card${isExpanded ? " is-expanded" : ""}`}
                style={{ "--project-accent": activeProject.state.accentCssColor } as CSSProperties}
              >
                <button
                  type="button"
                  className="projects-task-summary"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
                >
                  <SquareDashed className="task-status-icon" aria-hidden="true" size={18} strokeWidth={1.75} />
                  <span className="projects-task-title"><small>{task.id}</small>{task.label}</span>
                  <ChevronDown className="task-expand-mark" aria-hidden="true" size={18} strokeWidth={1.75} />
                </button>
                <div className="projects-task-expansion">
                  <div className="projects-task-detail">
                    <div className="projects-task-context-copy">
                      <span>Context</span>
                      <p>{task.context}</p>
                    </div>
                    <div className="projects-task-detail-bottom">
                      <div>
                        <span>Messages</span>
                        <p>#{activeProject.key}-{task.id.toLowerCase()}</p>
                        <p>Cynthia, Morgan, Arj</p>
                      </div>
                      <div>
                        <span>Agents</span>
                        <div className="projects-agent-row">
                          <img src={task.avatar} alt="" />
                          <img src="/berd-agent-avatars/pushback-gloopies-5.png" alt="" />
                          <img src="/berd-agent-avatars/builderbot-gloopies-20.png" alt="" />
                        </div>
                      </div>
                    </div>
                    <button type="button" className="projects-task-cta">Open task</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function TaskDetailPanel({
  selection,
  onClose,
}: {
  selection: SelectedTask;
  onClose: () => void;
}) {
  const { task, projectName } = selection;
  const [responseOpen, setResponseOpen] = useState(false);
  const [response, setResponse] = useState("");
  const responseRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setResponseOpen(false);
    setResponse("");
  }, [task.id]);

  useEffect(() => {
    if (!responseOpen) return;
    const focusTimer = window.setTimeout(() => responseRef.current?.focus(), 100);
    return () => window.clearTimeout(focusTimer);
  }, [responseOpen]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (responseOpen) setResponseOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, responseOpen]);

  return (
    <aside className="task-detail-panel" aria-label={`${task.label} task details`}>
      <header className="task-detail-header">
        <h2>{task.label}</h2>
        <button type="button" className="task-detail-close" onClick={onClose} aria-label="Close task details"><X aria-hidden="true" size={18} strokeWidth={1.75} /></button>
      </header>
      <div className="task-detail-divider" />
      <div className="task-meta-grid">
        <div className="task-meta task-meta-path"><span>Task</span><strong>{projectName} / {task.id} / {task.label}</strong></div>
        <div className="task-meta"><span>Created</span><strong>{task.created}</strong></div>
        <div className="task-meta"><span>Assigned to</span><strong>{task.assignee}</strong></div>
      </div>
      <div className="task-context">
        <span>Context</span>
        <p>{task.context}</p>
      </div>
      <div className="task-actions">
        <span>What would you like to do?</span>
        <div className={`task-action-list${responseOpen ? " is-composing" : ""}`}>
          {!responseOpen ? <button type="button">Approve</button> : null}
          {!responseOpen ? <button type="button">Deny</button> : null}
          <div className={`response-composer${responseOpen ? " is-open" : ""}`}>
            {responseOpen ? (
              <textarea
                ref={responseRef}
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                placeholder="Send a response"
                aria-label="Response"
              />
            ) : (
              <button type="button" className="response-composer-trigger" onClick={() => setResponseOpen(true)}>Send a response</button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

export function BuzzProjectPrototype() {
  const [activeTab, setActiveTab] = useState<"me" | "projects">("me");
  const [selectedTask, setSelectedTask] = useState<SelectedTask | null>(null);
  const projectWorldRef = useRef<HTMLDivElement>(null);
  const canvasPanRef = useRef({
    pointerId: -1,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    x: 0,
    y: 0,
  });

  const showTab = (tab: "me" | "projects") => {
    setSelectedTask(null);
    setActiveTab(tab);
  };

  const selectTask = (selection: SelectedTask) => {
    const pan = canvasPanRef.current;
    pan.pointerId = -1;
    pan.originX = 0;
    pan.originY = 0;
    pan.x = 0;
    pan.y = 0;
    projectWorldRef.current?.style.setProperty(
      "transform",
      "translate3d(0px, 0px, 0)",
    );
    setSelectedTask(selection);
  };

  const beginCanvasPan = (event: ReactPointerEvent<HTMLElement>) => {
    if (selectedTask) return;
    const target = event.target as Element;
    if (target.closest(".orbit-system, .task-detail-panel")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    canvasPanRef.current = {
      ...canvasPanRef.current,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: canvasPanRef.current.x,
      originY: canvasPanRef.current.y,
    };
    event.currentTarget.classList.add("is-panning");
  };

  const updateCanvasPan = (event: ReactPointerEvent<HTMLElement>) => {
    const pan = canvasPanRef.current;
    const world = projectWorldRef.current;
    if (!world || pan.pointerId !== event.pointerId) return;
    const limitX = window.innerWidth * 0.42;
    const limitY = window.innerHeight * 0.42;
    pan.x = Math.max(-limitX, Math.min(limitX, pan.originX + event.clientX - pan.startX));
    pan.y = Math.max(-limitY, Math.min(limitY, pan.originY + event.clientY - pan.startY));
    world.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0)`;
  };

  const endCanvasPan = (event: ReactPointerEvent<HTMLElement>) => {
    if (canvasPanRef.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    canvasPanRef.current.pointerId = -1;
    event.currentTarget.classList.remove("is-panning");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="header-spacer" aria-hidden="true" />
        <nav className="segmented" aria-label="Primary navigation">
          <button type="button" className={activeTab === "me" ? "selected" : ""} onClick={() => showTab("me")}>Me</button><button type="button">Messages</button><button type="button" className={activeTab === "projects" ? "selected" : ""} onClick={() => showTab("projects")}>Projects</button><button type="button" className="add-button" aria-label="Create new"><Plus aria-hidden="true" size={18} strokeWidth={1.75} /></button>
        </nav>
        <div className="utilities"><button type="button" className="round-button" aria-label="Search"><Search className="search-icon" aria-hidden="true" size={18} strokeWidth={1.75} /></button><div className="avatar" aria-label="Cynthia"><span>C</span></div></div>
      </header>

      {activeTab === "projects" ? (
        <ProjectsView />
      ) : (
        <section
          className="project-stage"
          aria-label="Buzz project activity prototype"
          onPointerDown={beginCanvasPan}
          onPointerMove={updateCanvasPan}
          onPointerUp={endCanvasPan}
          onPointerCancel={endCanvasPan}
        >
          <div
            ref={projectWorldRef}
            className="project-world"
            style={{ transform: `translate3d(${canvasPanRef.current.x}px, ${canvasPanRef.current.y}px, 0)` }}
          >
            <ProjectOrbit projectKey="berd" displayName="Berd" className="orbit-primary" imageUrls={PRIMARY_IMAGE_URLS} state={PRIMARY_PROJECT_STATE} tasks={PRIMARY_TASKS} selectedTask={selectedTask} onSelectTask={selectTask} />
            <ProjectOrbit projectKey="goose" displayName="Goose" className="orbit-secondary" imageUrls={SECONDARY_IMAGE_URLS} state={SECONDARY_PROJECT_STATE} tasks={SECONDARY_TASKS} selectedTask={selectedTask} onSelectTask={selectTask} />
            <ProjectOrbit projectKey="buzz" displayName="Buzz" className="orbit-tertiary" imageUrls={TERTIARY_IMAGE_URLS} state={TERTIARY_PROJECT_STATE} tasks={TERTIARY_TASKS} selectedTask={selectedTask} onSelectTask={selectTask} />
          </div>
          {selectedTask ? <TaskDetailPanel selection={selectedTask} onClose={() => setSelectedTask(null)} /> : null}
        </section>
      )}
    </main>
  );
}

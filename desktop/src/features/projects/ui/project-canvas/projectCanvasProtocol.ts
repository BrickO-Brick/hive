import { z } from "zod";

export const PROJECT_CANVAS_PROTOCOL_VERSION = 1 as const;
export const PROJECT_CANVAS_HANDSHAKE_TIMEOUT_MS = 8_000;
export const PROJECT_CANVAS_MAX_READY_BYTES = 4 * 1_024;
export const PROJECT_CANVAS_MAX_PORT_MESSAGE_BYTES = 64 * 1_024;
export const PROJECT_CANVAS_MAX_PACKAGE_DESCRIPTOR_BYTES = 320 * 1_024;
export const PROJECT_CANVAS_MAX_PENDING_UPDATES_BYTES = 640 * 1_024;
export const PROJECT_CANVAS_MAX_INIT_MESSAGE_BYTES = 2 * 1_024 * 1_024;
export const PROJECT_CANVAS_MESSAGE_RATE_LIMIT = 60;
export const PROJECT_CANVAS_MESSAGE_RATE_WINDOW_MS = 10_000;

const MAX_IDENTIFIER_LENGTH = 1_024;
const MAX_NONCE_LENGTH = 256;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

const capabilitySchema = z.enum([
  "project.metadata.read",
  "project.channels.read",
  "project.reviews.read",
]);

export type ProjectCanvasCapability = z.infer<typeof capabilitySchema>;
export type ProjectCanvasDataStatus = "loading" | "ready" | "error";

export type ProjectCanvasDataState<T> = {
  data: T | null;
  status: ProjectCanvasDataStatus;
};

export type ProjectCanvasProjectSummary = {
  description: string;
  id: string;
  name: string;
  owner: string;
  repositories: Array<{
    defaultBranch: string;
    description: string;
    id: string;
    name: string;
    owner: string;
    status: string;
  }>;
};

export type ProjectCanvasChannelSummary = {
  description: string;
  id: string;
  lastMessageAt: string | null;
  memberCount: number;
  name: string;
  people: Array<{
    avatarDataUrl: string | null;
    displayName: string | null;
    pubkey: string;
  }>;
  relationship: "home" | "related";
  topic: string | null;
};

export type ProjectCanvasReviewSummary = {
  agentName: string | null;
  agentPubkey: string | null;
  branch: string | null;
  displayId: string;
  id: string;
  status: "Approved" | "Changes requested" | "Requested" | "Reviewing";
  title: string;
};

export type ProjectCanvasSnapshots = {
  channels: ProjectCanvasDataState<ProjectCanvasChannelSummary[]>;
  project: ProjectCanvasDataState<ProjectCanvasProjectSummary>;
  reviews: ProjectCanvasDataState<ProjectCanvasReviewSummary[]>;
};

export type GrantedProjectCanvasSnapshots = Partial<ProjectCanvasSnapshots>;

const packageDescriptorSchema = z
  .object({
    capabilities: z.array(z.string().max(128)).max(32),
    data: z.unknown(),
    loadId: z.string().regex(/^[0-9a-f]{32}$/),
    nonce: z.string().min(16).max(MAX_NONCE_LENGTH),
    revision: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
    url: z.string().min(1).max(8_192),
  })
  .strict();

export type ProjectCanvasPackageDescriptor = z.infer<
  typeof packageDescriptorSchema
>;

const pendingUpdatesSchema = z
  .object({
    data: z
      .object({
        data: z.unknown(),
        notificationId: z.string().regex(/^[0-9a-f]{32}$/),
        revision: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
        widgetId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
      })
      .strict()
      .nullable(),
    presentation: z
      .object({
        notificationId: z.string().regex(/^[0-9a-f]{32}$/),
        package: packageDescriptorSchema,
        widgetId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ProjectCanvasPendingUpdates = z.infer<typeof pendingUpdatesSchema>;

const sourceUpdateEventSchema = z
  .object({
    communityId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  })
  .strict();

const readyMessageSchema = z
  .object({
    nonce: z.string().min(16).max(MAX_NONCE_LENGTH),
    protocolVersion: z.literal(PROJECT_CANVAS_PROTOCOL_VERSION),
    type: z.literal("canvas.ready"),
  })
  .strict();

const childBindingSchema = {
  loadId: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  nonce: z.string().min(16).max(MAX_NONCE_LENGTH),
  protocolVersion: z.literal(PROJECT_CANVAS_PROTOCOL_VERSION),
} as const;

const childMessageSchema = z
  .object({
    ...childBindingSchema,
    dashboard: z.string().min(1).max(128),
    type: z.literal("canvas.rendered"),
  })
  .strict();

export type ProjectCanvasChildMessage = z.infer<typeof childMessageSchema>;

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function isBoundedJsonValue(
  value: unknown,
  depth = 0,
  nodes = { count: 0 },
): boolean {
  nodes.count += 1;
  if (depth > MAX_JSON_DEPTH || nodes.count > MAX_JSON_NODES) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isBoundedJsonValue(item, depth + 1, nodes));
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) =>
    isBoundedJsonValue(item, depth + 1, nodes),
  );
}

function isAllowedCanvasUrl(
  value: string,
  loadId: string,
  allowDataUrl: boolean,
): boolean {
  if (allowDataUrl && value.startsWith("data:text/html")) return true;
  return (
    value === `buzz-canvas://localhost/${loadId}/` ||
    value === `http://buzz-canvas.localhost/${loadId}/`
  );
}

export function isMessageWithinSizeLimit(
  value: unknown,
  maxBytes: number,
): boolean {
  const byteLength = serializedByteLength(value);
  return byteLength !== null && byteLength <= maxBytes;
}

export function parseProjectCanvasPackageDescriptor(
  value: unknown,
): ProjectCanvasPackageDescriptor {
  return parsePackageDescriptor(value, false);
}

export function parseProjectCanvasPendingUpdates(
  value: unknown,
): ProjectCanvasPendingUpdates {
  if (
    !isMessageWithinSizeLimit(value, PROJECT_CANVAS_MAX_PENDING_UPDATES_BYTES)
  ) {
    throw new Error("Canvas pending updates exceed the host size limit.");
  }
  const parsed = pendingUpdatesSchema.parse(value);
  if (parsed.data && !isBoundedJsonValue(parsed.data.data)) {
    throw new Error("Canvas pending widget data is not bounded JSON.");
  }
  if (parsed.presentation) {
    parsePackageDescriptor(
      parsed.presentation.package,
      import.meta.env.MODE === "e2e",
    );
  }
  return parsed;
}

export function parseProjectCanvasSourceUpdateEvent(value: unknown): {
  communityId: string;
  projectId: string;
} | null {
  const parsed = sourceUpdateEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Test bridge variant. Production callers must use the custom-protocol parser. */
export function parseProjectCanvasPackageDescriptorForE2e(
  value: unknown,
): ProjectCanvasPackageDescriptor {
  return parsePackageDescriptor(value, true);
}

function parsePackageDescriptor(
  value: unknown,
  allowDataUrl: boolean,
): ProjectCanvasPackageDescriptor {
  if (
    !isMessageWithinSizeLimit(
      value,
      PROJECT_CANVAS_MAX_PACKAGE_DESCRIPTOR_BYTES,
    )
  ) {
    throw new Error("Canvas package response exceeds the host size limit.");
  }
  const parsed = packageDescriptorSchema.parse(value);
  if (!isBoundedJsonValue(parsed.data)) {
    throw new Error("Canvas package data is not bounded JSON.");
  }
  if (!isAllowedCanvasUrl(parsed.url, parsed.loadId, allowDataUrl)) {
    throw new Error("Canvas package returned an unsupported URL.");
  }
  return parsed;
}

export function parseProjectCanvasReady(
  value: unknown,
  expectedNonce: string,
): z.infer<typeof readyMessageSchema> | null {
  if (!isMessageWithinSizeLimit(value, PROJECT_CANVAS_MAX_READY_BYTES)) {
    return null;
  }
  const parsed = readyMessageSchema.safeParse(value);
  if (!parsed.success || parsed.data.nonce !== expectedNonce) return null;
  return parsed.data;
}

export function parseProjectCanvasChildMessage(
  value: unknown,
  expected: { loadId: string; nonce: string },
): ProjectCanvasChildMessage | null {
  if (!isMessageWithinSizeLimit(value, PROJECT_CANVAS_MAX_PORT_MESSAGE_BYTES)) {
    return null;
  }
  const parsed = childMessageSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.loadId !== expected.loadId ||
    parsed.data.nonce !== expected.nonce
  ) {
    return null;
  }
  return parsed.data;
}

export function grantedProjectCanvasCapabilities(
  requested: readonly string[],
): ProjectCanvasCapability[] {
  const granted = new Set<ProjectCanvasCapability>();
  for (const candidate of requested) {
    const parsed = capabilitySchema.safeParse(candidate);
    if (parsed.success) granted.add(parsed.data);
  }
  return [...granted];
}

export function selectGrantedProjectCanvasSnapshots(
  snapshots: ProjectCanvasSnapshots,
  capabilities: readonly ProjectCanvasCapability[],
): GrantedProjectCanvasSnapshots {
  const selected: GrantedProjectCanvasSnapshots = {};
  if (capabilities.includes("project.metadata.read")) {
    selected.project = snapshots.project;
  }
  if (capabilities.includes("project.channels.read")) {
    selected.channels = snapshots.channels;
  }
  if (capabilities.includes("project.reviews.read")) {
    selected.reviews = snapshots.reviews;
  }
  return selected;
}

export class ProjectCanvasMessageRateLimiter {
  private acceptedAt: number[] = [];

  accept(now: number): boolean {
    const cutoff = now - PROJECT_CANVAS_MESSAGE_RATE_WINDOW_MS;
    this.acceptedAt = this.acceptedAt.filter((timestamp) => timestamp > cutoff);
    if (this.acceptedAt.length >= PROJECT_CANVAS_MESSAGE_RATE_LIMIT) {
      return false;
    }
    this.acceptedAt.push(now);
    return true;
  }
}

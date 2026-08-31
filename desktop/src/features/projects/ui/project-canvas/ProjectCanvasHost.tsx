import { invokeTauri } from "@/shared/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  AlertTriangle,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import * as React from "react";

import {
  grantedProjectCanvasCapabilities,
  isMessageWithinSizeLimit,
  parseProjectCanvasChildMessage,
  parseProjectCanvasPackageDescriptor,
  parseProjectCanvasPackageDescriptorForE2e,
  parseProjectCanvasPendingUpdates,
  parseProjectCanvasReady,
  parseProjectCanvasSourceUpdateEvent,
  PROJECT_CANVAS_HANDSHAKE_TIMEOUT_MS,
  PROJECT_CANVAS_MAX_INIT_MESSAGE_BYTES,
  PROJECT_CANVAS_PROTOCOL_VERSION,
  ProjectCanvasMessageRateLimiter,
  selectGrantedProjectCanvasSnapshots,
  type ProjectCanvasPackageDescriptor,
  type ProjectCanvasPendingUpdates,
  type ProjectCanvasSnapshots,
} from "./projectCanvasProtocol";

type ProjectCanvasMode = "preview" | "full";

type ProjectCanvasHostProps = {
  communityId: string | null;
  full: boolean;
  projectName: string;
  projectNames: readonly string[];
  projectId: string;
  snapshots: ProjectCanvasSnapshots;
};

type PackageRequest = {
  communityId: string;
  projectId: string;
};

const MAX_INVALID_PORT_MESSAGES = 3;
const PROJECT_CANVAS_SOURCE_UPDATE_EVENT = "project-canvas-source-updated";
const parsePackageDescriptor =
  import.meta.env.MODE === "e2e"
    ? parseProjectCanvasPackageDescriptorForE2e
    : parseProjectCanvasPackageDescriptor;

async function requestProjectCanvasPackage(
  command: "activate_project_canvas_package" | "get_project_canvas_package",
  request: PackageRequest,
): Promise<ProjectCanvasPackageDescriptor> {
  const response = await invokeTauri<unknown>(command, { request });
  return parsePackageDescriptor(response);
}

async function releaseProjectCanvasPackage(loadId: string): Promise<void> {
  await invokeTauri("release_project_canvas_package", { loadId });
}

async function commitProjectCanvasPackage(loadId: string): Promise<void> {
  await invokeTauri("commit_project_canvas_package", { loadId });
}

async function requestProjectCanvasUpdates(
  request: PackageRequest,
): Promise<ProjectCanvasPendingUpdates> {
  const response = await invokeTauri<unknown>("get_project_canvas_updates", {
    request,
  });
  return parseProjectCanvasPendingUpdates(response);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Canvas package failed.";
}

export function ProjectCanvasHost({
  communityId,
  full,
  projectId,
  projectName,
  projectNames,
  snapshots,
}: ProjectCanvasHostProps) {
  const [descriptor, setDescriptor] =
    React.useState<ProjectCanvasPackageDescriptor | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [dataUpdate, setDataUpdate] =
    React.useState<ProjectCanvasPendingUpdates["data"]>(null);
  const requestGenerationRef = React.useRef(0);
  const candidateLoadIdRef = React.useRef<string | null>(null);
  const restoredLoadIdRef = React.useRef<string | null>(null);
  const lastDataNotificationRef = React.useRef<string | null>(null);
  const lastPresentationNotificationRef = React.useRef<string | null>(null);
  const bindingKey = `${communityId ?? ""}\u0000${projectId}`;
  const bindingKeyRef = React.useRef(bindingKey);
  bindingKeyRef.current = bindingKey;

  React.useEffect(
    () => () => {
      requestGenerationRef.current += 1;
    },
    [],
  );

  React.useEffect(() => {
    let disposed = false;
    const generation = ++requestGenerationRef.current;
    const requestedBinding = bindingKey;
    candidateLoadIdRef.current = null;
    restoredLoadIdRef.current = null;
    setDescriptor(null);
    setLoadError(null);
    setReloading(false);
    setDataUpdate(null);
    lastDataNotificationRef.current = null;
    lastPresentationNotificationRef.current = null;

    if (!communityId) {
      setLoadError("Canvas is unavailable until the community is ready.");
      return () => {
        disposed = true;
      };
    }

    void requestProjectCanvasPackage("get_project_canvas_package", {
      communityId,
      projectId,
    })
      .then((nextDescriptor) => {
        if (
          disposed ||
          requestGenerationRef.current !== generation ||
          bindingKeyRef.current !== requestedBinding
        ) {
          void releaseProjectCanvasPackage(nextDescriptor.loadId).catch(
            () => {},
          );
          return;
        }
        setDescriptor(nextDescriptor);
      })
      .catch((error: unknown) => {
        if (
          !disposed &&
          requestGenerationRef.current === generation &&
          bindingKeyRef.current === requestedBinding
        ) {
          setLoadError(errorMessage(error));
        }
      });

    return () => {
      disposed = true;
    };
  }, [bindingKey, communityId, projectId]);

  React.useEffect(() => {
    if (!communityId) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let queued = Promise.resolve();
    const requestedBinding = bindingKey;

    const sync = async () => {
      let updates: ProjectCanvasPendingUpdates;
      try {
        updates = await requestProjectCanvasUpdates({ communityId, projectId });
      } catch (error) {
        if (!disposed && bindingKeyRef.current === requestedBinding) {
          setLoadError(errorMessage(error));
        }
        return;
      }
      if (disposed || bindingKeyRef.current !== requestedBinding) {
        if (updates.presentation) {
          await releaseProjectCanvasPackage(
            updates.presentation.package.loadId,
          ).catch(() => {});
        }
        return;
      }

      if (updates.presentation) {
        if (
          updates.presentation.notificationId ===
          lastPresentationNotificationRef.current
        ) {
          await releaseProjectCanvasPackage(
            updates.presentation.package.loadId,
          ).catch(() => {});
        } else {
          lastPresentationNotificationRef.current =
            updates.presentation.notificationId;
          requestGenerationRef.current += 1;
          candidateLoadIdRef.current = updates.presentation.package.loadId;
          setReloading(true);
          setLoadError(null);
          setDescriptor(updates.presentation.package);
        }
      }
      if (
        updates.data &&
        updates.data.notificationId !== lastDataNotificationRef.current
      ) {
        lastDataNotificationRef.current = updates.data.notificationId;
        setDataUpdate(updates.data);
      }
    };
    const scheduleSync = () => {
      queued = queued.then(sync, sync);
    };

    void listen<unknown>(PROJECT_CANVAS_SOURCE_UPDATE_EVENT, (event) => {
      const binding = parseProjectCanvasSourceUpdateEvent(event.payload);
      if (
        binding?.communityId === communityId &&
        binding.projectId === projectId
      ) {
        scheduleSync();
      }
    })
      .then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        scheduleSync();
      })
      .catch((error: unknown) => {
        if (!disposed && bindingKeyRef.current === requestedBinding) {
          setLoadError(errorMessage(error));
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [bindingKey, communityId, projectId]);

  React.useEffect(() => {
    if (!descriptor) return;
    return () => {
      void releaseProjectCanvasPackage(descriptor.loadId).catch(() => {});
    };
  }, [descriptor]);

  const reload = React.useCallback(async () => {
    if (!communityId || reloading) return;
    const generation = ++requestGenerationRef.current;
    const requestedBinding = bindingKey;
    setReloading(true);
    setLoadError(null);
    try {
      const nextDescriptor = await requestProjectCanvasPackage(
        "activate_project_canvas_package",
        { communityId, projectId },
      );
      if (
        requestGenerationRef.current !== generation ||
        bindingKeyRef.current !== requestedBinding
      ) {
        await releaseProjectCanvasPackage(nextDescriptor.loadId).catch(
          () => {},
        );
        return;
      }
      candidateLoadIdRef.current = nextDescriptor.loadId;
      setDescriptor(nextDescriptor);
    } catch (error) {
      if (
        requestGenerationRef.current === generation &&
        bindingKeyRef.current === requestedBinding
      ) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (requestGenerationRef.current === generation) {
        setReloading(false);
      }
    }
  }, [bindingKey, communityId, projectId, reloading]);

  const handleFrameFailure = React.useCallback(
    (loadId: string, message: string) => {
      if (candidateLoadIdRef.current !== loadId || !communityId) {
        setDescriptor((current) =>
          current?.loadId === loadId ? null : current,
        );
        setLoadError(message);
        return;
      }

      candidateLoadIdRef.current = null;
      const generation = ++requestGenerationRef.current;
      const requestedBinding = bindingKey;
      setLoadError(
        `Canvas reload failed; restored the active version. ${message}`,
      );
      setReloading(true);
      void requestProjectCanvasPackage("get_project_canvas_package", {
        communityId,
        projectId,
      })
        .then((activeDescriptor) => {
          if (
            requestGenerationRef.current !== generation ||
            bindingKeyRef.current !== requestedBinding
          ) {
            void releaseProjectCanvasPackage(activeDescriptor.loadId).catch(
              () => {},
            );
            return;
          }
          restoredLoadIdRef.current = activeDescriptor.loadId;
          setDescriptor(activeDescriptor);
        })
        .catch((error: unknown) => {
          if (
            requestGenerationRef.current === generation &&
            bindingKeyRef.current === requestedBinding
          ) {
            setDescriptor(null);
            setLoadError(
              `Canvas reload failed and the active version could not be restored. ${errorMessage(error)}`,
            );
          }
        })
        .finally(() => {
          if (requestGenerationRef.current === generation) {
            setReloading(false);
          }
        });
    },
    [bindingKey, communityId, projectId],
  );

  const handleFrameRendered = React.useCallback((loadId: string) => {
    if (restoredLoadIdRef.current === loadId) {
      restoredLoadIdRef.current = null;
      return;
    }
    if (candidateLoadIdRef.current === loadId) {
      candidateLoadIdRef.current = null;
    }
    setLoadError(null);
    setReloading(false);
  }, []);

  const openSource = React.useCallback(async () => {
    if (!communityId) return;
    try {
      await invokeTauri("open_project_canvas_source", {
        request: { communityId, projectId },
      });
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [communityId, projectId]);

  return (
    <section
      aria-busy={!descriptor && !loadError}
      aria-label="Project widget canvas"
      className="relative h-full min-h-0 w-full overflow-hidden bg-muted/35"
      data-testid="project-widget-canvas"
    >
      {descriptor ? (
        <ProjectCanvasFrame
          descriptor={descriptor}
          dataUpdate={dataUpdate}
          key={descriptor.loadId}
          mode={full ? "full" : "preview"}
          onFailure={handleFrameFailure}
          onRendered={handleFrameRendered}
          projectId={projectId}
          projectName={projectName}
          projectNames={projectNames}
          snapshots={snapshots}
        />
      ) : loadError ? (
        <CanvasFailure message={loadError} onReload={() => void reload()} />
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <LoaderCircle
            aria-label="Loading Canvas"
            className="h-5 w-5 animate-spin"
          />
        </div>
      )}

      {communityId ? (
        <div className="absolute right-3 top-3 z-40 flex gap-1">
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <Button
                aria-label="Open Canvas files"
                className="h-8 w-8 border-border/80 bg-background/95 shadow-sm"
                data-testid="project-canvas-open-source"
                onClick={() => void openSource()}
                size="icon"
                type="button"
                variant="outline"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open Canvas files</TooltipContent>
          </Tooltip>
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <Button
                aria-label="Reload Canvas"
                className="h-8 w-8 border-border/80 bg-background/95 shadow-sm"
                data-testid="project-canvas-reload"
                disabled={reloading}
                onClick={() => void reload()}
                size="icon"
                type="button"
                variant="outline"
              >
                <RefreshCw
                  className={cn("h-4 w-4", reloading && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reload Canvas</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {descriptor && loadError ? (
        <div className="absolute inset-x-14 top-3 z-40 flex justify-center">
          <div
            className="flex max-w-xl items-center gap-3 rounded-sm border border-destructive/35 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm"
            data-testid="project-canvas-reload-error"
            role="alert"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{loadError}</span>
            <Button
              className="shrink-0"
              disabled={reloading}
              onClick={() => void reload()}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw
                className={cn("h-4 w-4", reloading && "animate-spin")}
              />
              Retry
            </Button>
          </div>
        </div>
      ) : null}
      {descriptor ? (
        <div className="pointer-events-none absolute bottom-3 left-3 z-40 rounded-sm border border-border/70 bg-background/90 px-2 py-1 text-3xs font-medium text-muted-foreground shadow-sm">
          Local Canvas
        </div>
      ) : null}
    </section>
  );
}

function CanvasFailure({
  message,
  onReload,
}: {
  message: string;
  onReload: () => void;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="project-canvas-error"
      role="alert"
    >
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <div>
        <p className="text-sm font-medium">Canvas could not load</p>
        <p className="mt-1 max-w-lg text-xs text-muted-foreground">{message}</p>
      </div>
      <Button onClick={onReload} size="sm" type="button" variant="outline">
        <RefreshCw className="h-4 w-4" />
        Retry
      </Button>
    </div>
  );
}

function ProjectCanvasFrame({
  dataUpdate,
  descriptor,
  mode,
  onFailure,
  onRendered,
  projectId,
  projectName,
  projectNames,
  snapshots,
}: {
  dataUpdate: ProjectCanvasPendingUpdates["data"];
  descriptor: ProjectCanvasPackageDescriptor;
  mode: ProjectCanvasMode;
  onFailure: (loadId: string, message: string) => void;
  onRendered: (loadId: string) => void;
  projectId: string;
  projectName: string;
  projectNames: readonly string[];
  snapshots: ProjectCanvasSnapshots;
}) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const portRef = React.useRef<MessagePort | null>(null);
  const modeRef = React.useRef(mode);
  const snapshotsRef = React.useRef(snapshots);
  const projectNameRef = React.useRef(projectName);
  const projectNamesRef = React.useRef(projectNames);
  const connectedRef = React.useRef(false);
  const loadCountRef = React.useRef(0);
  const lastSnapshotsJsonRef = React.useRef<string | null>(null);
  const lastWidgetDataNotificationRef = React.useRef<string | null>(null);
  const [connected, setConnected] = React.useState(false);
  const [rendered, setRendered] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [frameSource, setFrameSource] = React.useState<string | undefined>();

  modeRef.current = mode;
  snapshotsRef.current = snapshots;
  projectNameRef.current = projectName;
  projectNamesRef.current = projectNames;

  const fail = React.useCallback(
    (message: string) => {
      connectedRef.current = false;
      portRef.current?.close();
      portRef.current = null;
      setConnected(false);
      setRendered(false);
      setFailed(true);
      setFrameSource(undefined);
      void releaseProjectCanvasPackage(descriptor.loadId).catch(() => {});
      onFailure(descriptor.loadId, message);
    },
    [descriptor.loadId, onFailure],
  );

  React.useLayoutEffect(() => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) {
      fail("Canvas frame could not be created.");
      return;
    }

    const capabilities = grantedProjectCanvasCapabilities(
      descriptor.capabilities,
    );
    const rateLimiter = new ProjectCanvasMessageRateLimiter();
    let invalidMessageCount = 0;
    let handshakeComplete = false;
    let renderAcknowledged = false;
    let stopped = false;
    let timeoutId = 0;
    const stop = (message: string) => {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timeoutId);
      fail(message);
    };
    timeoutId = window.setTimeout(() => {
      stop("Canvas did not complete its secure handshake and render.");
    }, PROJECT_CANVAS_HANDSHAKE_TIMEOUT_MS);

    const handleReady = (event: MessageEvent) => {
      if (stopped) return;
      if (event.source !== frameWindow) return;
      if (
        typeof event.data !== "object" ||
        event.data === null ||
        !("type" in event.data) ||
        event.data.type !== "canvas.ready"
      ) {
        return;
      }
      if (!parseProjectCanvasReady(event.data, descriptor.nonce)) {
        stop("Canvas sent an invalid handshake.");
        return;
      }
      if (handshakeComplete || connectedRef.current) {
        stop("Canvas attempted to reconnect unexpectedly.");
        return;
      }

      const channel = new MessageChannel();
      const grantedSnapshots = selectGrantedProjectCanvasSnapshots(
        snapshotsRef.current,
        capabilities,
      );
      const initMessage = {
        canvasId: projectId,
        capabilities,
        data: descriptor.data,
        loadId: descriptor.loadId,
        mode: modeRef.current,
        nonce: descriptor.nonce,
        project: {
          displayName: projectNameRef.current,
          id: projectId,
          name: projectNameRef.current,
          names: [...projectNamesRef.current].slice(0, 8),
        },
        protocolVersion: PROJECT_CANVAS_PROTOCOL_VERSION,
        snapshots: grantedSnapshots,
        type: "host.init",
      } as const;
      if (
        !isMessageWithinSizeLimit(
          initMessage,
          PROJECT_CANVAS_MAX_INIT_MESSAGE_BYTES,
        )
      ) {
        channel.port1.close();
        channel.port2.close();
        stop("Canvas initialization exceeds the host size limit.");
        return;
      }

      channel.port1.addEventListener("message", (portEvent) => {
        if (!rateLimiter.accept(performance.now())) {
          stop("Canvas exceeded the host message rate limit.");
          return;
        }
        const message = parseProjectCanvasChildMessage(portEvent.data, {
          loadId: descriptor.loadId,
          nonce: descriptor.nonce,
        });
        if (!message) {
          invalidMessageCount += 1;
          if (invalidMessageCount >= MAX_INVALID_PORT_MESSAGES) {
            stop("Canvas sent repeated invalid messages.");
          }
          return;
        }
        invalidMessageCount = 0;
        if (message.type === "canvas.rendered") {
          if (renderAcknowledged) {
            stop("Canvas reported completion more than once.");
            return;
          }
          renderAcknowledged = true;
          void commitProjectCanvasPackage(descriptor.loadId)
            .then(() => {
              if (stopped) return;
              window.clearTimeout(timeoutId);
              setRendered(true);
              onRendered(descriptor.loadId);
            })
            .catch((error: unknown) => {
              stop(errorMessage(error));
            });
        }
        // canvas.rendered is the only child-to-host message in this POC.
      });
      channel.port1.addEventListener("messageerror", () => {
        stop("Canvas sent an unreadable message.");
      });
      channel.port1.start();
      portRef.current = channel.port1;

      frameWindow.postMessage(
        {
          loadId: descriptor.loadId,
          nonce: descriptor.nonce,
          protocolVersion: PROJECT_CANVAS_PROTOCOL_VERSION,
          type: "host.connect",
        },
        "*",
        [channel.port2],
      );
      channel.port1.postMessage(initMessage);
      lastSnapshotsJsonRef.current = JSON.stringify(grantedSnapshots);
      handshakeComplete = true;
      connectedRef.current = true;
      setConnected(true);
    };

    window.addEventListener("message", handleReady);
    setFrameSource(descriptor.url);
    return () => {
      stopped = true;
      handshakeComplete = true;
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleReady);
      connectedRef.current = false;
      portRef.current?.close();
      portRef.current = null;
    };
  }, [descriptor, fail, onRendered, projectId]);

  React.useEffect(() => {
    if (!connectedRef.current || !portRef.current) return;
    portRef.current.postMessage({
      loadId: descriptor.loadId,
      mode,
      nonce: descriptor.nonce,
      protocolVersion: PROJECT_CANVAS_PROTOCOL_VERSION,
      type: "host.mode",
    });
  }, [descriptor.loadId, descriptor.nonce, mode]);

  React.useEffect(() => {
    const port = portRef.current;
    if (!connected || !port) return;
    const capabilities = grantedProjectCanvasCapabilities(
      descriptor.capabilities,
    );
    const grantedSnapshots = selectGrantedProjectCanvasSnapshots(
      snapshots,
      capabilities,
    );
    const serialized = JSON.stringify(grantedSnapshots);
    if (serialized === lastSnapshotsJsonRef.current) return;
    const message = {
      loadId: descriptor.loadId,
      nonce: descriptor.nonce,
      protocolVersion: PROJECT_CANVAS_PROTOCOL_VERSION,
      snapshots: grantedSnapshots,
      type: "host.dataChanged",
    } as const;
    if (
      !isMessageWithinSizeLimit(message, PROJECT_CANVAS_MAX_INIT_MESSAGE_BYTES)
    ) {
      fail("Canvas data update exceeds the host size limit.");
      return;
    }
    port.postMessage(message);
    lastSnapshotsJsonRef.current = serialized;
  }, [connected, descriptor, fail, snapshots]);

  React.useEffect(() => {
    const port = portRef.current;
    if (
      !connected ||
      !port ||
      !dataUpdate ||
      dataUpdate.notificationId === lastWidgetDataNotificationRef.current
    ) {
      return;
    }
    const message = {
      data: dataUpdate.data,
      loadId: descriptor.loadId,
      nonce: descriptor.nonce,
      notificationId: dataUpdate.notificationId,
      protocolVersion: PROJECT_CANVAS_PROTOCOL_VERSION,
      type: "host.widgetDataChanged",
      widgetId: dataUpdate.widgetId,
    } as const;
    if (
      !isMessageWithinSizeLimit(message, PROJECT_CANVAS_MAX_INIT_MESSAGE_BYTES)
    ) {
      fail("Canvas widget data update exceeds the host size limit.");
      return;
    }
    port.postMessage(message);
    lastWidgetDataNotificationRef.current = dataUpdate.notificationId;
  }, [connected, dataUpdate, descriptor.loadId, descriptor.nonce, fail]);

  return (
    <div className="relative h-full min-h-0 w-full bg-background">
      {!failed ? (
        <iframe
          allow="autoplay"
          className="h-full w-full border-0 bg-transparent"
          data-canvas-connected={connected ? "true" : "false"}
          data-canvas-rendered={rendered ? "true" : "false"}
          data-testid="project-canvas-frame"
          onError={() => fail("Canvas frame failed to load.")}
          onLoad={() => {
            if (!frameSource) return;
            loadCountRef.current += 1;
            if (loadCountRef.current > 1) {
              fail("Canvas navigated away from its host shell.");
            }
          }}
          ref={frameRef}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          src={frameSource}
          title={`${projectName} Canvas`}
        />
      ) : null}
      {!rendered && !failed ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 text-muted-foreground">
          <LoaderCircle
            aria-label="Connecting Canvas"
            className="h-5 w-5 animate-spin"
          />
        </div>
      ) : null}
    </div>
  );
}

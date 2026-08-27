export const MESH_SHARE_MODEL_STORAGE_KEY = "buzz.mesh-compute.share.model.v1";
export const MESH_SHARE_MAX_VRAM_STORAGE_KEY =
  "buzz.mesh-compute.share.max-vram-gb.v1";

export function readMeshShareDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeMeshShareDraft(key: string, value: string): void {
  try {
    if (value === "") {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Unavailable/full storage must not block changing the live setting.
  }
}

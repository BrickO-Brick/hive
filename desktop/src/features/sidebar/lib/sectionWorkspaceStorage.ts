import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";

const CACHE_PREFIX = "buzz-section-workspace.v1";
const IMPORT_ACTION_PREFIX = `${CACHE_PREFIX}:import-action`;
const IMPORT_COMMAND_PREFIX = `${CACHE_PREFIX}:import-command`;

function importActionKey(pubkey: string, relayUrl: string): string {
  return `${IMPORT_ACTION_PREFIX}:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
}
function importCommandKey(pubkey: string, relayUrl: string): string {
  return `${IMPORT_COMMAND_PREFIX}:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
}
export function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function readStoredImportCommand(
  pubkey: string,
  relayUrl: string,
): string | null {
  return readStoredValue(importCommandKey(pubkey, relayUrl));
}
export function hasImportMarker(pubkey: string, relayUrl: string): boolean {
  return (
    readStoredValue(importActionKey(pubkey, relayUrl)) !== null ||
    readStoredImportCommand(pubkey, relayUrl) !== null
  );
}
export function readStoredImportAction(
  pubkey: string,
  relayUrl: string,
): string | null {
  return readStoredValue(importActionKey(pubkey, relayUrl));
}
export function clearImportAction(pubkey: string, relayUrl: string): boolean {
  try {
    const key = importActionKey(pubkey, relayUrl);
    window.localStorage.removeItem(key);
    return window.localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}
export function writeImportState(
  pubkey: string,
  relayUrl: string,
  actionId: string,
  command: string,
): boolean {
  try {
    const commandKey = importCommandKey(pubkey, relayUrl);
    const actionKey = importActionKey(pubkey, relayUrl);
    window.localStorage.setItem(commandKey, command);
    window.localStorage.setItem(actionKey, actionId);
    return (
      window.localStorage.getItem(commandKey) === command &&
      window.localStorage.getItem(actionKey) === actionId
    );
  } catch {
    return false;
  }
}

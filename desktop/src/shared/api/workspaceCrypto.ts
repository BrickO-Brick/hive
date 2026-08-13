import { invokeTauri } from "./tauri";

export async function generateWorkspaceKey(): Promise<string> {
  return invokeTauri<string>("generate_workspace_key");
}

export async function encryptWorkspaceMetadata(input: {
  keyHex: string;
  plaintext: string;
  aad: string;
}): Promise<string> {
  return invokeTauri<string>("encrypt_workspace_metadata", input);
}

export async function decryptWorkspaceMetadata(input: {
  keyHex: string;
  envelope: string;
  aad: string;
}): Promise<string> {
  return invokeTauri<string>("decrypt_workspace_metadata", input);
}

import type { EnvVarsValue } from "./EnvVarsEditor";
import { getProviderApiKeyEnvVar } from "./agentConfigOptions";

const OPENAI_COMPAT_BASE_URL = "OPENAI_COMPAT_BASE_URL";

function normalizedProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/**
 * Pure env-var update helpers shared by the persona / create-agent /
 * edit-agent dialogs. Every function returns the SAME reference when nothing
 * changes, so `setEnvVars(fn(current))` skips a no-op re-render.
 */

/** Remove `envKey` when present. */
export function envVarsWithoutKey(
  current: EnvVarsValue,
  envKey: string,
): EnvVarsValue {
  if (!(envKey in current)) {
    return current;
  }

  const next = { ...current };
  delete next[envKey];
  return next;
}

/** Remove the compatible endpoint when switching away from openai-compat. */
export function envVarsClearingOpenAiCompatBaseUrl(
  current: EnvVarsValue,
  previousProvider: string,
  nextProvider: string,
): EnvVarsValue {
  if (
    normalizedProvider(previousProvider) === "openai-compat" &&
    normalizedProvider(nextProvider) !== "openai-compat"
  ) {
    return envVarsWithoutKey(current, OPENAI_COMPAT_BASE_URL);
  }
  return current;
}

/**
 * Clear the previous provider's managed API key and provider-owned endpoint
 * when switching providers.
 */
export function envVarsClearingManagedApiKey(
  current: EnvVarsValue,
  previousProvider: string,
  nextProvider: string,
): EnvVarsValue {
  const previousEnvVar = getProviderApiKeyEnvVar(previousProvider);
  const nextEnvVar = getProviderApiKeyEnvVar(nextProvider);
  let next = current;
  if (previousEnvVar && previousEnvVar !== nextEnvVar) {
    next = envVarsWithoutKey(next, previousEnvVar);
  }
  next = envVarsClearingOpenAiCompatBaseUrl(
    next,
    previousProvider,
    nextProvider,
  );
  return next;
}

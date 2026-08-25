import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFileSizeCheck } from "../../scripts/check-file-sizes-core.mjs";
import { rules } from "./file-size-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

export const policy = {
  projectRoot,
  rules,
  label: "Desktop",
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await runFileSizeCheck(policy);
}

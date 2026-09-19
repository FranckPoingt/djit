import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);
const repoRoot = path.resolve(thisDirPath, "../../..");
const serverDir = path.join(repoRoot, "apps/server");
const specPath = path.join(serverDir, "openapi.json");
const outputPath = path.join(repoRoot, "packages/api-client/src/generated.ts");
const miseExecPath = path.join(repoRoot, "scripts/mise-exec.sh");

execFileSync(
  miseExecPath,
  ["uv", "run", "python", "scripts/export_openapi.py"],
  {
    cwd: serverDir,
    stdio: "inherit",
  },
);

execFileSync(
  "pnpm",
  ["exec", "openapi-typescript", specPath, "-o", outputPath],
  {
    cwd: path.join(repoRoot, "packages/api-client"),
    stdio: "inherit",
  },
);

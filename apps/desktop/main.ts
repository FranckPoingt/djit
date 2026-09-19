function dataDir(
  os: typeof Deno.build.os,
  env: Record<string, string>,
): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error("Cannot find the user home directory");
  if (os === "darwin") return `${home}/Library/Application Support/DJ-IT`;
  if (os === "windows") return `${env.LOCALAPPDATA ?? home}/DJ-IT`;
  return `${env.XDG_DATA_HOME ?? `${home}/.local/share`}/djit`;
}

if (
  dataDir("darwin", { HOME: "/tmp/user" }) !==
    "/tmp/user/Library/Application Support/DJ-IT"
) {
  throw new Error("Desktop data path self-check failed");
}

const env = Deno.env.toObject();
const appData = dataDir(Deno.build.os, env);
await Deno.mkdir(appData, { recursive: true });
const instanceLock = await Deno.open(`${appData}/app.lock`, {
  create: true,
  write: true,
});
if (!(await instanceLock.tryLock(true))) Deno.exit(0);

const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const backendPort = (listener.addr as Deno.NetAddr).port;
listener.close();
const backendOrigin = `http://127.0.0.1:${backendPort}`;
let backendStarted = false;
let backend: Deno.ChildProcess | undefined;
let shuttingDown = false;

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function unavailableResponse(request: Request): Response {
  if (request.headers.get("accept")?.includes("text/html")) {
    return new Response(
      '<!doctype html><meta http-equiv="refresh" content="1"><title>DJ-IT</title>Starting DJ-IT…',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  return Response.json(
    { detail: "DJ-IT backend is restarting" },
    { status: 503, headers: { "retry-after": "1" } },
  );
}

async function waitForBackend(): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backendStarted) return true;
    await delay(100);
  }
  return false;
}

Deno.serve(async (request) => {
  if (
    !backendStarted &&
    (request.headers.get("accept")?.includes("text/html") ||
      !(await waitForBackend()))
  ) {
    return unavailableResponse(request);
  }
  const incoming = new URL(request.url);
  try {
    return await fetch(
      new Request(
        `${backendOrigin}${incoming.pathname}${incoming.search}`,
        request,
      ),
    );
  } catch {
    return unavailableResponse(request);
  }
});

const executable = Deno.build.os === "windows"
  ? "djit-server.exe"
  : "djit-server";
const embeddedBackendDir = new URL(
  "../server/dist/djit-server/",
  import.meta.url,
);
const executableDir = Deno.execPath().slice(
  0,
  Deno.execPath().lastIndexOf("/"),
);
const backendDir = Deno.build.os === "darwin"
  ? `${executableDir}/../Resources/djit-server`
  : `${appData}/bin/${
    (await Deno.readTextFile(
      new URL(".build-id", embeddedBackendDir),
    )).trim()
  }`;
const backendPath = `${backendDir}/${executable}`;

async function materializeDirectory(
  source: URL,
  target: string,
): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourceEntry = new URL(
      `${encodeURIComponent(entry.name)}${entry.isDirectory ? "/" : ""}`,
      source,
    );
    const targetEntry = `${target}/${entry.name}`;
    if (entry.isDirectory) {
      await materializeDirectory(sourceEntry, targetEntry);
      continue;
    }
    const input = await Deno.open(sourceEntry, { read: true });
    const output = await Deno.open(targetEntry, {
      write: true,
      create: true,
      truncate: true,
    });
    await input.readable.pipeTo(output.writable);
  }
}

if (Deno.build.os !== "darwin") {
  const backendBuildId = backendDir.slice(backendDir.lastIndexOf("/") + 1);
  if (!/^[a-f0-9]{16}$/.test(backendBuildId)) {
    throw new Error("DJ-IT backend build ID is invalid");
  }
  let backendReady = false;
  try {
    backendReady =
      (await Deno.readTextFile(`${backendDir}/.complete`)) === "ok";
  } catch {
    // First launch.
  }
  if (!backendReady) {
    await materializeDirectory(embeddedBackendDir, backendDir);
    if (Deno.build.os !== "windows") await Deno.chmod(backendPath, 0o755);
    await Deno.writeTextFile(`${backendDir}/.complete`, "ok");
  }
}

async function superviseBackend(): Promise<void> {
  while (!shuttingDown) {
    backendStarted = false;
    const child = new Deno.Command(backendPath, {
      env: {
        DJIT_ANALYSIS_DSP_CONCURRENCY: "1",
        DJIT_ANALYSIS_ENGINE: "essentia",
        DJIT_ANALYSIS_EXECUTOR: "thread",
        DJIT_ANALYSIS_KEY_HPSS_ENABLED: "0",
        DJIT_ANALYSIS_WORKERS: "1",
        DJIT_BACKEND_PORT: String(backendPort),
        DJIT_DB_PATH: `${appData}/djit.db`,
      },
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    backend = child;
    let exited = false;
    const statusPromise = child.status.then((status) => {
      exited = true;
      return status;
    });

    for (let attempt = 0; attempt < 600 && !exited; attempt++) {
      try {
        const response = await fetch(`${backendOrigin}/api/v1/health`);
        if (response.ok) {
          backendStarted = true;
          break;
        }
      } catch {
        // Still starting.
      }
      await delay(100);
    }

    if (!backendStarted && !exited) {
      child.kill("SIGTERM");
    }
    const status = await statusPromise;
    backendStarted = false;
    if (backend === child) backend = undefined;
    if (shuttingDown) break;
    console.error(
      `DJ-IT backend exited code=${status.code} signal=${status.signal}; restarting`,
    );
    await delay(1000);
  }
}

const backendSupervisor = superviseBackend();

addEventListener("unload", () => {
  shuttingDown = true;
  backendStarted = false;
  instanceLock.close();
  try {
    backend?.kill("SIGTERM");
  } catch {
    // Already stopped.
  }
});

await backendSupervisor;

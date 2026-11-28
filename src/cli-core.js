import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir, platform } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { toPublicUsageReport } from "./usage-sources.js";
import {
  planHistoryArchive,
  prepareHistoryArchiveCommit,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
  restoreHistoryArchiveBundle,
  verifyPublishedHistoryArchiveBundle,
} from "./history-archive.js";
import { createHistoryBackup, restoreHistoryBackup, verifyHistoryBackup } from "./history-backup.js";
import { formatUsageServerUrl } from "./server-core.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3765;
const DASHBOARD_PORTS = [DEFAULT_PORT, 3766, 3767, 3768, 3769, 3770];
const DEFAULT_GATEWAY_MEMORY_MB = 512;
const DEFAULT_STATE_FILE = path.join(homedir(), ".codex-usage", "services.json");
const SERVICE_LOCK_WAIT_MS = 5000;
const SERVICE_LOCK_STALE_MS = 15000;
const SERVICE_REPLACE_RETRY_MS = 1000;

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function splitCommand(argv, defaultCommand = "summary") {
  if (argv[0] === "-d") {
    return { command: "dashboard", args: argv.slice(1) };
  }
  if (argv[0] && !argv[0].startsWith("-")) {
    return { command: argv[0], args: argv.slice(1) };
  }
  return { command: defaultCommand, args: argv };
}

function hasFlag(args, name) {
  return args.includes(name);
}

function readOption(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function reportOptions(args) {
  const homeDir = readOption(args, "--home-dir");
  return homeDir ? { homeDir } : {};
}

function profilePath(directory, cwd = process.cwd()) {
  const absolute = path.resolve(cwd, directory || homedir());
  let profile = absolute;
  try {
    profile = realpathSync(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return platform() === "win32" ? profile.toLowerCase() : profile;
}

function stateFilePath(args) {
  return readOption(args, "--state-file", process.env.CODEX_USAGE_STATE_FILE || DEFAULT_STATE_FILE);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parsePositiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  return number;
}

function withoutOption(args, name) {
  const nextArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      index += 1;
      continue;
    }
    nextArgs.push(args[index]);
  }
  return nextArgs;
}

function invokedAsCud() {
  return path.basename(process.argv[1] || "") === "cud";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Wait for bounded service cleanup before accepting a restart.
async function waitForProcessExit(pid, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessRunning(pid);
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readServices(filePath) {
  const current = await readJsonFile(filePath);
  return Array.isArray(current?.services) ? current.services : [];
}

async function writeServices(filePath, services) {
  await writeJsonFile(filePath, { services });
}

async function writeJsonFile(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(content, null, 2));
    const deadline = Date.now() + SERVICE_REPLACE_RETRY_MS;
    while (true) {
      try {
        await rename(temporary, filePath);
        break;
      } catch (error) {
        // Windows briefly blocks replacement while a reader has the target open.
        if ((error.code !== "EPERM" && error.code !== "EBUSY") || Date.now() >= deadline) {
          throw error;
        }
        await sleep(10);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withServicesLock(filePath, callback, waitMs = SERVICE_LOCK_WAIT_MS) {
  const lockPath = `${filePath}.lock`;
  let deadline = Date.now() + waitMs;

  await mkdir(path.dirname(filePath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      let isStale = false;
      try {
        const info = await stat(lockPath);
        isStale = Date.now() - info.mtimeMs > SERVICE_LOCK_STALE_MS;
      } catch (statError) {
        if (statError.code !== "ENOENT") {
          throw statError;
        }
      }

      if (isStale || Date.now() > deadline) {
        await rm(lockPath, { recursive: true, force: true });
        deadline = Date.now() + waitMs;
        continue;
      }
      await sleep(25);
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeService(filePath, pid) {
  await withServicesLock(filePath, async () => {
    const services = await readServices(filePath);
    const nextServices = services.filter((service) => service.pid !== pid);
    if (nextServices.length === 0) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }
    await writeServices(filePath, nextServices);
  });
}

async function registerService(filePath, service) {
  await withServicesLock(filePath, async () => {
    const services = await readServices(filePath);
    const liveServices = services.filter((entry) => entry.pid && isProcessRunning(entry.pid));
    const nextServices = liveServices.filter((entry) => entry.pid !== service.pid);
    nextServices.push(service);
    await writeServices(filePath, nextServices);
  });
}

async function runningServices(filePath) {
  return (await readServices(filePath)).filter(
    (service) => service.pid && isProcessRunning(service.pid) && service.url,
  );
}

function printHuman(summary) {
  console.log(`Total tokens: ${formatNumber(summary.totals.total)}`);
  console.log(`Input tokens: ${formatNumber(summary.totals.input)}`);
  console.log(`Cached input: ${formatNumber(summary.totals.cached)}`);
  console.log(`Output tokens: ${formatNumber(summary.totals.output)}`);
  console.log(`Reasoning output: ${formatNumber(summary.totals.reasoning)}`);
  console.log(`Sessions: ${formatNumber(summary.sessionCount)}`);
  console.log("");
  console.log("By channel:");
  for (const channel of summary.channels) {
    console.log(`- ${channel.name}: ${formatNumber(channel.total.total)}`);
  }
}

export { readServices, writeServices };

/** Concrete entries bind their own server, executor, facts/report and optional Waifu features. */
export async function runCli({
  edition,
  entryFile,
  createUsageServer,
  createUsageExecutor,
  UsageStore,
  buildUsageReport,
  summarizeUsage,
  features = null,
  historyOptions = {},
}) {
  entryFile = realpathSync(entryFile);
  const displayName = edition === "lite" ? "Agent Usage" : "Waifu Usage";
  const sameEntry = (service) => {
    if (service.edition !== edition || typeof service.entryFile !== "string") return false;
    try {
      const actual = realpathSync(service.entryFile);
      return process.platform === "win32" ? actual.toLowerCase() === entryFile.toLowerCase() : actual === entryFile;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  const withBackup = (file, work) => (features ? features.withAchievementBackup(file, work) : work({}));
  const USAGE = `${displayName}

Usage:
  waifu-usage summary [--json] [--home-dir <dir>]
  waifu-usage json [--home-dir <dir>]
  waifu-usage dashboard [--host <host>] [--port <port>] [--home-dir <dir>]
  waifu-usage -d [--host <host>] [--port <port>] [--home-dir <dir>]
  waifu-usage gateway [--host <host>] [--port <port>] [--home-dir <dir>] [--memory-mb <mb>]
  waifu-usage restart [--host <host>] [--port <port>] [--home-dir <dir>] [--memory-mb <mb>]
  waifu-usage run [--host <host>] [--port <port>] [--home-dir <dir>]
  waifu-usage stop
  waifu-usage history verify <databaseFile>
  waifu-usage history backup <sourceDB> <newPackageDB>
  waifu-usage history compact <sourceDB> <maintenanceDirectory> [--rollback]
  waifu-usage history export <sourceDB> <newDirectory> [--home-dir <dir>]
  waifu-usage history import <publishedBundleDir> <newImportDir>
  waifu-usage history restore <packageDB|bundleDir> <newDB|newDir> [--home-dir <dir>]${features?.restoreUsageSuffix || ""}
  waifu-usage history archive <sourceDB> --dry-run
  waifu-usage history archive <sourceDB> --commit <verifiedCandidateDB> --backup <newBundleDir> [--home-dir <dir>]`;

  async function waitForRegisteredService(filePath, pid, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const service = (await readServices(filePath)).find((entry) => entry.pid === pid);
      if (service && sameEntry(service) && isProcessRunning(pid)) {
        return service;
      }
      if (!isProcessRunning(pid)) {
        throw new Error("Gateway service exited before it was ready.");
      }
      await sleep(100);
    }
    throw new Error("Timed out waiting for gateway service to start.");
  }

  async function verifyDashboardService(service) {
    if (
      typeof service.host !== "string" ||
      !Number.isInteger(service.port) ||
      service.url !== formatUsageServerUrl(service.host, service.port)
    )
      return false;
    if (!service.instanceId) return true;
    try {
      return await new Promise((resolve, reject) => {
        const request = httpRequest(
          new URL("/internal/identity", service.url),
          { method: "HEAD", signal: AbortSignal.timeout(1000) },
          (response) => {
            response.resume();
            resolve(response.statusCode === 204 && response.headers["x-codex-usage-instance"] === service.instanceId);
          },
        );
        request.once("error", reject);
        request.end();
      });
    } catch {
      return false;
    }
  }

  async function printSummary(command, args) {
    await features?.loadPricing(reportOptions(args));
    if (command === "json") {
      const report = await buildUsageReport(reportOptions(args));
      const summary = summarizeUsage(report, { preset: "all", bucket: "month" });
      console.log(JSON.stringify({ report: toPublicUsageReport(report), summary }, null, 2));
      return;
    }

    // 摘要命令复用磁盘索引，避免历史事件常驻内存。
    const store = new UsageStore(reportOptions(args));
    try {
      await store.sync();
      const summary = store.summarize({ preset: "all", bucket: "month" });
      if (hasFlag(args, "--json")) {
        console.log(JSON.stringify({ metadata: store.metadata(), summary }, null, 2));
        return;
      }
      printHuman(summary);
    } finally {
      store.close();
    }
  }

  function runServer(args) {
    const host = readOption(args, "--host", process.env.HOST || DEFAULT_HOST);
    const port = parsePort(readOption(args, "--port", process.env.PORT || String(DEFAULT_PORT)));
    const preferredPort = readOption(args, "--preferred-dashboard-port");
    const candidatePorts =
      preferredPort === undefined ? [port] : [...new Set([parsePort(preferredPort), ...DASHBOARD_PORTS])];
    let attempt = 0;
    const stateFile = stateFilePath(args);
    const shutdownToken = randomBytes(32).toString("hex");
    const instanceId = randomBytes(16).toString("hex");
    const options = reportOptions(args);
    let shuttingDown = false;
    let registered = false;
    const server = createUsageServer({
      ...options,
      listenHost: host,
      shutdownToken,
      instanceId,
      onShutdown: () => void shutdown(),
    });

    server.once("listening", async () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : candidatePorts[attempt];
      const url = formatUsageServerUrl(host, actualPort);
      try {
        await registerService(stateFile, {
          pid: process.pid,
          edition,
          entryFile,
          shutdownToken,
          instanceId,
          homeDir: profilePath(options.homeDir),
          host,
          port: actualPort,
          url,
          cwd: process.cwd(),
          argv: process.argv.slice(1),
          nodeExecArgv: process.execArgv,
          startedAt: new Date().toISOString(),
        });
        registered = true;
        console.log(`${displayName} dashboard: ${url}`);
      } catch (error) {
        reportStartupError(error.message);
        server.close(() => {
          process.exit(1);
        });
      }
    });

    server.on("error", async (error) => {
      if (!registered && error.code === "EADDRINUSE" && attempt + 1 < candidatePorts.length) {
        attempt += 1;
        server.listen(candidatePorts[attempt], host);
        return;
      }
      const message =
        error.code !== "EADDRINUSE"
          ? error.message
          : preferredPort === undefined
            ? `${error.message}. Choose a free port with --port <port>.`
            : `EADDRINUSE: dashboard ports ${DEFAULT_PORT}–${DASHBOARD_PORTS.at(-1)} on ${host} are in use. Choose a free port with --port <port>.`;
      reportStartupError(message);
      if (registered) await removeService(stateFile, process.pid);
      process.exitCode = 1;
    });

    function reportStartupError(message) {
      console.error(message);
      if (process.connected) process.send?.({ error: message });
    }

    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      await removeService(stateFile, process.pid);
      server.close(() => {
        process.exit(0);
      });
    };

    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
    server.listen(candidatePorts[attempt], host);
  }

  async function startGateway(args, { announce = true, preferredPort = undefined } = {}) {
    const stateFile = stateFilePath(args);
    const cliPath = entryFile;
    const memoryMb = parsePositiveInteger(
      readOption(args, "--memory-mb", process.env.CODEX_USAGE_MEMORY_MB || String(DEFAULT_GATEWAY_MEMORY_MB)),
      "--memory-mb",
    );
    const runArgs = withoutOption(args, "--memory-mb");
    if (preferredPort !== undefined) runArgs.push("--preferred-dashboard-port", String(preferredPort));
    const child = spawn(process.execPath, [`--max-old-space-size=${memoryMb}`, cliPath, "run", ...runArgs], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    let startupError;
    child.on("message", (message) => {
      if (message && typeof message === "object" && "error" in message && typeof message.error === "string") {
        startupError = message.error;
      }
    });
    child.on("error", (error) => {
      startupError = error.message;
    });
    try {
      const service = await waitForRegisteredService(stateFile, child.pid);
      if (announce) {
        console.log(`${displayName} gateway started: ${service.url} (pid ${service.pid})`);
      }
      return service;
    } catch (error) {
      if (child.exitCode === null && child.pid) child.kill();
      throw startupError ? new Error(startupError) : error;
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
    }
  }

  function openUrl(url) {
    const currentPlatform = platform();
    const opener =
      currentPlatform === "darwin"
        ? { command: "open", args: [url] }
        : currentPlatform === "win32"
          ? { command: "cmd", args: ["/c", "start", "", url] }
          : { command: "xdg-open", args: [url] };
    const child = spawn(opener.command, opener.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      console.error(`Unable to open dashboard: ${error.message}`);
    });
    child.unref();
  }

  async function openDashboard(args) {
    const stateFile = stateFilePath(args);
    const host = readOption(args, "--host", process.env.HOST || DEFAULT_HOST);
    const portOption = readOption(args, "--port", process.env.PORT || undefined);
    const port = portOption === undefined ? undefined : parsePort(portOption);
    const profile = profilePath(reportOptions(args).homeDir);
    const preferredFile = `${stateFile}.dashboard.json`;
    const service = await withServicesLock(
      preferredFile,
      async () => {
        for (const active of await runningServices(stateFile)) {
          const sameInstallation = sameEntry(active);
          if (!sameInstallation && port !== undefined) continue;
          const activeProfile =
            active.homeDir ||
            profilePath(reportOptions(Array.isArray(active.argv) ? active.argv : []).homeDir, active.cwd);
          if (activeProfile !== profile || !(await verifyDashboardService(active))) continue;
          if (sameInstallation && active.host === host && (!port || active.port === port)) return active;
          throw new Error(
            `This data folder is already served at ${active.url}. Stop that service before starting another.`,
          );
        }
        if (port !== undefined) return startGateway(args, { announce: false });

        const key = JSON.stringify([edition, entryFile, profile, host]);
        const saved = (await readJsonFile(preferredFile)) ?? {};
        const rememberedPort = saved[key];
        const preferredPort = DASHBOARD_PORTS.includes(rememberedPort) ? rememberedPort : DEFAULT_PORT;
        const started = await startGateway(args, { announce: false, preferredPort });
        if (started.port !== preferredPort) {
          try {
            await writeJsonFile(preferredFile, { ...saved, [key]: started.port });
          } catch (error) {
            console.error(`Unable to remember the dashboard port: ${error.message}`);
          }
        }
        return started;
      },
      SERVICE_LOCK_STALE_MS,
    );
    if (!hasFlag(args, "--no-open") && process.env.CODEX_USAGE_OPEN !== "0") {
      openUrl(service.url);
    }
    console.log(`${displayName} dashboard: ${service.url}`);
  }

  async function requestServiceShutdown(service) {
    if (service.shutdownToken && service.url) {
      try {
        // The OS can assign a listening port that fetch forbids, even for local shutdown.
        return await new Promise((resolve, reject) => {
          const request = httpRequest(
            new URL("/internal/shutdown", service.url),
            {
              method: "POST",
              headers: { "x-codex-usage-shutdown-token": service.shutdownToken },
              signal: AbortSignal.timeout(1500),
            },
            (response) => {
              response.once("error", reject);
              response.once("end", () => resolve(response.statusCode === 202));
              response.resume();
            },
          );
          request.once("error", reject);
          request.end();
        });
      } catch {
        return false;
      }
    }
    try {
      process.kill(service.pid, "SIGTERM");
      return true;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }

  async function stopRunningServices(args, { announce = true } = {}) {
    const stateFile = stateFilePath(args);
    const services = await readServices(stateFile);
    const runningServices = services.filter(
      (service) =>
        service.pid &&
        service.pid !== process.pid &&
        isProcessRunning(service.pid) &&
        (service.edition == null || service.edition === edition),
    );

    const stoppedServices = [];
    const stillRunningServices = [];
    const requestedServices = [];
    for (const service of runningServices) {
      if (await requestServiceShutdown(service)) {
        requestedServices.push(service);
      } else {
        stillRunningServices.push(service);
      }
    }
    for (const service of requestedServices) {
      if (await waitForProcessExit(service.pid)) {
        stoppedServices.push(service);
      } else {
        stillRunningServices.push(service);
      }
    }

    await withServicesLock(stateFile, async () => {
      const liveServices = (await readServices(stateFile)).filter(
        (service) => service.pid && isProcessRunning(service.pid),
      );
      await writeServices(stateFile, liveServices);
    });

    if (stillRunningServices.length > 0) {
      if (announce) {
        console.error(
          `Stopped ${stoppedServices.length} ${displayName} service(s), ${stillRunningServices.length} still running.`,
        );
      }
      return { stoppedServices, stillRunningServices };
    }

    if (announce) {
      console.log(
        runningServices.length
          ? `Stopped ${stoppedServices.length} ${displayName} service(s).`
          : `No running ${displayName} services found.`,
      );
    }
    return { stoppedServices, stillRunningServices };
  }

  async function stopServers(args) {
    const { stillRunningServices } = await stopRunningServices(args);
    if (stillRunningServices.length > 0) {
      process.exitCode = 1;
    }
  }

  async function restartGateway(args) {
    const { stillRunningServices } = await stopRunningServices(args);
    if (stillRunningServices.length > 0) {
      process.exitCode = 1;
      return;
    }

    const service = await startGateway(args, { announce: false });
    console.log(`${displayName} gateway restarted: ${service.url} (pid ${service.pid})`);
  }

  async function verifyHistoryCommand(args) {
    const [subcommand, databaseFile, ...extra] = args;
    if (subcommand !== "verify" || !databaseFile || extra.length > 0) {
      console.error("Usage: waifu-usage history verify <databaseFile>");
      process.exitCode = 1;
      return;
    }

    try {
      const verified = await verifyHistoryBackup(databaseFile);
      console.log("History backup verified.");
      console.log(`Schema: ${verified.manifest.schemaVersion}`);
      console.log("Tables:");
      for (const [table, evidence] of Object.entries(verified.manifest.tables).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        console.log(`- ${table}: ${formatNumber(evidence.rows)}`);
      }
      const captured = verified.manifest.serviceTierEvidence;
      console.log(
        captured === null
          ? "Service-tier evidence: not captured"
          : `Service-tier evidence: captured (${formatNumber(captured.snapshot.threads.length)} threads)`,
      );
    } catch (error) {
      console.error(
        `History backup verification failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
      );
      process.exitCode = 1;
    }
  }

  async function backupHistoryCommand(args) {
    const [subcommand, sourceFile, destinationFile, ...extra] = withoutOption(args, "--home-dir");
    if (subcommand !== "backup" || !sourceFile || !destinationFile || extra.length > 0) {
      console.error("Usage: waifu-usage history backup <sourceDB> <newPackageDB> [--home-dir <dir>]");
      process.exitCode = 1;
      return;
    }

    try {
      await features?.loadPricing(reportOptions(args));
      const source = new DatabaseSync(sourceFile, { readOnly: true });
      try {
        await withBackup(sourceFile, (extension) =>
          createHistoryBackup(source, destinationFile, { ...historyOptions, ...extension }),
        );
      } finally {
        source.close();
      }
      console.log("History backup created.");
      console.log(`Database: ${path.resolve(destinationFile)}`);
      console.log("Service-tier evidence: not captured");
      console.log("Source database was not modified.");
    } catch (error) {
      console.error(
        `History backup creation failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
      );
      process.exitCode = 1;
    }
  }

  async function restoreHistoryCommand(args) {
    const fullProfile = hasFlag(args, "--with-achievements");
    const filtered = withoutOption(args, "--home-dir").filter((value) => value !== "--with-achievements");
    const [subcommand, packageFile, destinationFile, ...extra] = filtered;
    if (subcommand !== "restore" || !packageFile || !destinationFile || extra.length > 0) {
      console.error(
        `Usage: waifu-usage history restore <packageDB|bundleDir> <newDB|newDir> [--home-dir <dir>]${features?.restoreUsageSuffix || ""}`,
      );
      process.exitCode = 1;
      return;
    }

    try {
      const bundle = (await stat(packageFile)).isDirectory();
      const verified = bundle
        ? await verifyPublishedHistoryArchiveBundle(packageFile)
        : await verifyHistoryBackup(packageFile);
      const target = path.resolve(destinationFile);
      const restore = (extension = {}) =>
        bundle
          ? restoreHistoryArchiveBundle(packageFile, target, { ...historyOptions, ...extension })
          : restoreHistoryBackup(packageFile, target, undefined, { ...historyOptions, ...extension });
      const completed = features
        ? await features.restoreHistory({
            bundle,
            verified,
            target,
            fullProfile,
            restore,
            homeDir: readOption(args, "--home-dir", homedir()),
          })
        : { result: await restore(), replayed: false };
      const restored = completed.result;
      if (completed.replayed) console.log("Restore already completed; achievement record replayed.");
      console.log("History backup restored.");
      console.log(`Database: ${restored?.restoredTo || restored?.runtimeFile || target}`);
      if (restored?.manifestFile) console.log(`Manifest: ${restored.manifestFile}`);
      if (completed.achievementError) console.error(`Achievement record pending: ${completed.achievementError}`);
      console.log("Online service was not switched.");
    } catch (error) {
      console.error(
        `History backup restore failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
      );
      process.exitCode = 1;
    }
  }

  async function exportHistoryCommand(args) {
    const [subcommand, sourceFile, destinationDirectory, ...extra] = withoutOption(args, "--home-dir");
    if (subcommand !== "export" || !sourceFile || !destinationDirectory || extra.length > 0) {
      console.error("Usage: waifu-usage history export <sourceDB> <newDirectory> [--home-dir <dir>]");
      process.exitCode = 1;
      return;
    }

    try {
      await features?.loadPricing(reportOptions(args));
      const homeDir = readOption(args, "--home-dir");
      const serviceTierEvidence = features?.serviceTierEvidence(homeDir, "cli-export", "CLI export") ?? null;
      const source = new DatabaseSync(sourceFile, { readOnly: true });
      try {
        const published = await withBackup(sourceFile, (extension) =>
          publishHistoryArchiveBundle(source, destinationDirectory, {
            ...historyOptions,
            serviceTierEvidence,
            ...extension,
          }),
        );
        console.log("History bundle exported.");
        console.log(`Directory: ${published.directory}`);
        console.log(`Manifest: ${published.manifestFile}`);
        console.log(`Completion marker: ${published.markerFile}`);
        console.log("Source database was not modified.");
      } finally {
        source.close();
      }
    } catch (error) {
      console.error(
        `History bundle export failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
      );
      process.exitCode = 1;
    }
  }

  async function importHistoryCommand(args) {
    const [subcommand, sourceDirectory, destinationDirectory, ...extra] = args;
    if (subcommand !== "import" || !sourceDirectory || !destinationDirectory || extra.length > 0) {
      console.error("Usage: waifu-usage history import <publishedBundleDir> <newImportDir>");
      process.exitCode = 1;
      return;
    }

    try {
      const imported = await publishHistoryArchiveImport(sourceDirectory, destinationDirectory, historyOptions);
      console.log("History bundle imported.");
      console.log(`Runtime: ${imported.runtimeFile}`);
      console.log(`Bundle: ${imported.bundleDirectory}`);
      console.log(`Import marker: ${imported.markerFile}`);
      console.log("Online service was not switched.");
    } catch (error) {
      console.error(
        `History bundle import failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
      );
      process.exitCode = 1;
    }
  }

  async function compactHistoryCommand(args) {
    const [, sourceFile, directory, ...extra] = args;
    if (!sourceFile || !directory || extra.some((arg) => arg !== "--rollback") || extra.length > 1) {
      console.error("Usage: waifu-usage history compact <sourceDB> <maintenanceDirectory> [--rollback]");
      process.exitCode = 1;
      return;
    }
    const store = new UsageStore({ databaseFile: path.resolve(sourceFile) });
    try {
      if (!(await stat(sourceFile)).isFile()) throw new Error("Archive maintenance requires an existing database file");
      const { compactRegisteredHistory } = await import("./history-archive-compaction.js");
      const result = await compactRegisteredHistory(store, directory, {
        ...historyOptions,
        rollback: extra.includes("--rollback"),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`History archive maintenance failed: ${error?.code ? `${error.code}: ` : ""}${error.message}`);
      process.exitCode = 1;
    } finally {
      store.close();
    }
  }

  async function archiveHistoryCommand(args) {
    const [subcommand, sourceFile, ...archiveArgs] = args;
    if (subcommand !== "archive" || !sourceFile) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }

    let source;
    let executor;
    try {
      const dryRun = archiveArgs.length === 1 && archiveArgs[0] === "--dry-run";
      if (!dryRun) {
        if (!hasFlag(archiveArgs, "--commit") && !hasFlag(archiveArgs, "--backup")) {
          console.error("Usage: waifu-usage history archive <sourceDB> --dry-run");
          process.exitCode = 1;
          return;
        }
        const candidateFile = readOption(archiveArgs, "--commit");
        const backupDirectory = readOption(archiveArgs, "--backup");
        const remaining = withoutOption(
          withoutOption(withoutOption(archiveArgs, "--commit"), "--backup"),
          "--home-dir",
        );
        if (!candidateFile || !backupDirectory || remaining.length > 0) {
          console.error(
            "Usage: waifu-usage history archive <sourceDB> --commit <verifiedCandidateDB> --backup <newBundleDir> [--home-dir <dir>]",
          );
          process.exitCode = 1;
          return;
        }

        await features?.loadPricing(reportOptions(args));
        const homeDir = readOption(args, "--home-dir");
        const serviceTierEvidence =
          features?.serviceTierEvidence(homeDir, "cli-archive-commit", "CLI archive commit") ?? null;
        source = new DatabaseSync(sourceFile, { readOnly: true });
        const plan = await prepareHistoryArchiveCommit(source, candidateFile);
        const published = await publishHistoryArchiveBundle(source, backupDirectory, {
          ...historyOptions,
          serviceTierEvidence,
        });
        await verifyPublishedHistoryArchiveBundle(published.directory);
        source.close();
        source = null;

        executor = createUsageExecutor({ ...reportOptions(args), databaseFile: path.resolve(sourceFile) });
        await executor.open();
        const committed = await executor.commitHistoryArchiveEvents(plan);
        console.log("History archive committed.");
        console.log(`Backup: ${published.directory}`);
        console.log(`Manifest: ${published.manifestFile}`);
        console.log(`Completion marker: ${published.markerFile}`);
        console.log(`Segment: ${committed.segmentId}`);
        console.log(`Deleted events: ${formatNumber(committed.deletedEventCount)}`);
        console.log(`Replay: ${committed.replay ? "yes" : "no"}`);
        console.log("Online service was not switched.");
        return;
      }

      source = new DatabaseSync(sourceFile, { readOnly: true });
      const plan = planHistoryArchive(source, { asOf: Date.now() });
      console.log("History archive dry-run.");
      console.log(`Eligible: ${plan.eligible ? "yes" : "no"}`);
      console.log(`Reason: ${plan.reason}`);
      console.log(`Events: ${formatNumber(plan.eventCount)}`);
      console.log(`Cold events: ${formatNumber(plan.coldEventCount)}`);
      console.log(`Cutoff local: ${new Date(plan.cutoffMs).toLocaleString()}`);
      console.log(`Cutoff epoch ms: ${plan.cutoffMs}`);
    } catch (error) {
      console.error(
        `History archive ${archiveArgs[0] === "--dry-run" ? "dry-run" : "commit"} failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
      );
      process.exitCode = 1;
    } finally {
      source?.close();
      await executor?.close();
    }
  }

  async function main() {
    const { command, args } = splitCommand(process.argv.slice(2), invokedAsCud() ? "dashboard" : "summary");

    if (!features && args.some((arg) => arg === "--with-achievements" || arg.startsWith("--with-achievements="))) {
      console.error("History backup restore failed: Full achievement restore requires the Waifu edition");
      process.exitCode = 1;
      return;
    }

    if (command === "help" || hasFlag(args, "--help") || hasFlag(args, "-h")) {
      console.log(USAGE);
      return;
    }

    if (command === "run" || command === "serve") {
      runServer(args);
      return;
    }

    if (command === "gateway") {
      await startGateway(args);
      return;
    }

    if (command === "restart") {
      await restartGateway(args);
      return;
    }

    if (command === "dashboard") {
      await openDashboard(args);
      return;
    }

    if (command === "stop") {
      await stopServers(args);
      return;
    }

    if (command === "summary" || command === "json") {
      await printSummary(command, args);
      return;
    }

    if (command === "history") {
      if (args[0] === "backup") {
        await backupHistoryCommand(args);
      } else if (args[0] === "restore") {
        await restoreHistoryCommand(args);
      } else if (args[0] === "export") {
        await exportHistoryCommand(args);
      } else if (args[0] === "import") {
        await importHistoryCommand(args);
      } else if (args[0] === "archive") {
        await archiveHistoryCommand(args);
      } else if (args[0] === "compact") {
        await compactHistoryCommand(args);
      } else {
        await verifyHistoryCommand(args);
      }
      return;
    }

    console.error(USAGE);
    process.exitCode = 1;
  }

  await main();
}

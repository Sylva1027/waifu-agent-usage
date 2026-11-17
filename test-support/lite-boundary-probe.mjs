import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CALL_PROBE = Symbol.for("codex-usage.lite-boundary-call");
const ROOT = new URL("../", import.meta.url);

function moduleUrl(value) {
  const url =
    value instanceof URL ? new URL(value) : new URL(path.isAbsolute(value) ? pathToFileURL(value) : value, ROOT);
  url.search = "";
  url.hash = "";
  return url.href;
}

/** Pass env to the scenario parent AND to children that replace their environment. */
export function createLiteBoundaryProbe(root, { forbiddenModules = [], forbiddenCalls = [], calls = [] } = {}) {
  const directory = mkdtempSync(path.join(root, "boundary-probe-"));
  const config = {
    directory,
    controllerPid: process.pid,
    forbiddenModules: forbiddenModules.map(moduleUrl),
    forbiddenCalls,
    calls: calls.map((point) => ({ ...point, module: moduleUrl(point.module) })),
  };
  const read = () =>
    readdirSync(directory)
      .filter((file) => /^\d+\.jsonl$/.test(file))
      .flatMap((file) =>
        readFileSync(path.join(directory, file), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
  return {
    directory,
    config,
    env: {
      ...process.env,
      LITE_BOUNDARY_PROBE: JSON.stringify(config),
      // NODE_OPTIONS survives a fork's explicit execArgv (the executor sets its own heap flags).
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${import.meta.url}`.trim(),
    },
    read,
    count: (name, pid) =>
      read().filter((entry) => entry.kind === "call" && entry.name === name && (pid === undefined || entry.pid === pid))
        .length,
  };
}

/** Anchors end inside the real function body; missing/ambiguous anchors fail instead of silently counting zero. */
export function installLiteBoundaryProbe(config) {
  assert.equal(globalThis[CALL_PROBE], undefined, "boundary probe already installed");
  const file = path.join(config.directory, `${process.pid}.jsonl`);
  const record = (kind, fields = {}) => {
    appendFileSync(
      file,
      `${JSON.stringify({
        pid: process.pid,
        ppid: process.ppid,
        role: process.pid === config.controllerPid || process.ppid === config.controllerPid ? "parent" : "child",
        kind,
        ...fields,
      })}\n`,
    );
  };
  const forbiddenModules = new Set(config.forbiddenModules);
  const forbiddenCalls = new Set(config.forbiddenCalls);
  const call = (name) => {
    record("call", { name, forbidden: forbiddenCalls.has(name) });
    if (forbiddenCalls.has(name))
      throw Object.assign(new Error(`Forbidden boundary call: ${name}`), { code: "LITE_BOUNDARY_CALL" });
  };
  globalThis[CALL_PROBE] = call;
  record("start");
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      record("resolve", { specifier, parentURL: context.parentURL, url: result.url });
      return result;
    },
    load(url, context, next) {
      const canonical = moduleUrl(url);
      const forbidden = forbiddenModules.has(canonical);
      record("load", { url, forbidden });
      if (forbidden)
        throw Object.assign(new Error(`Forbidden boundary module: ${canonical}`), { code: "LITE_BOUNDARY_MODULE" });
      const loaded = next(url, context);
      const points = config.calls.filter((point) => point.module === canonical);
      if (!points.length) return loaded;
      let source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
      for (const point of points) {
        assert.ok(point.anchor, "a call probe needs a nonempty source anchor");
        assert.equal(source.split(point.anchor).length, 2, `Boundary probe anchor moved: ${point.name}`);
        const statement = `globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(CALL_PROBE))})](${JSON.stringify(point.name)});`;
        source = source.replace(
          point.anchor,
          () => `${point.anchor}\n${point.when ? `if (${point.when}) ` : ""}${statement}\n`,
        );
      }
      return { ...loaded, source };
    },
  });
  const onExit = () => record("exit");
  process.once("exit", onExit);
  let closed = false;
  return {
    call,
    close() {
      if (closed) return;
      closed = true;
      hooks.deregister();
      process.off("exit", onExit);
      delete globalThis[CALL_PROBE];
    },
  };
}

// Only an explicit test preload installs hooks; importing this helper has no product imports or hooks.
if (process.env.LITE_BOUNDARY_PROBE) installLiteBoundaryProbe(JSON.parse(process.env.LITE_BOUNDARY_PROBE));

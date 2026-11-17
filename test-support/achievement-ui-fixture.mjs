import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPaletteFixture, createPaletteServerOptions } from "./skin-palette-fixture.mjs";
import { listenOnFetchPort } from "./fetch-port.mjs";
import { createUsageServer } from "../src/server.js";
import { AchievementStore } from "../src/achievement-store.js";
import { achievementDatabaseFile } from "../src/achievement-foundation.js";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "../src/achievement-catalog.js";

// Only temporary source logs and an isolated achievement archive; all HTTP responses are production code.
export async function createAchievementUiFixture({ empty = false, edition = "waifu" } = {}) {
  const fixture = await createPaletteFixture();
  let server;
  let url;
  try {
    const imports = JSON.parse(await readFile(fixture.importStoreFile, "utf8"));
    const source = imports.imports.find((entry) => entry.kind === "project-log");
    const logFile = path.join(source.path, ".codex-usage", "usage.jsonl");
    const template = JSON.parse((await readFile(logFile, "utf8")).split("\n")[0]);
    let sequence = 0;
    const tokenEvent = ({ model = "gpt-6-sol", total, ...overrides }) => ({
      ...template,
      timestamp: new Date(Date.parse("2026-10-02T12:00:00Z") + ++sequence * 60_000).toISOString(),
      model,
      session_id: `achievement-ui-${model}`,
      request_id: `achievement-ui-${sequence}`,
      usage: { input: total, cached: 0, output: 0, reasoning: 0, total },
      ...overrides,
    });
    if (empty) await writeFile(logFile, "");
    else
      await appendFile(
        logFile,
        [
          tokenEvent({ total: 210_000_000_000 }),
          tokenEvent({ model: "hy4free", total: 15_000_000_000 }),
          tokenEvent({ model: "claude-sonnet-4", total: 1_100_000_000 }),
        ]
          .map((row) => `${JSON.stringify(row)}\n`)
          .join(""),
      );
    if (edition === "waifu") {
      const archive = new AchievementStore({
        databaseFile: achievementDatabaseFile(fixture.databaseFile),
        catalog: ACHIEVEMENT_CATALOG,
      });
      archive.open({
        enabledAt: "2026-09-25T00:00:00Z",
        timeZone: "Asia/Shanghai",
        rulesVersion: ACHIEVEMENT_RULES_VERSION,
        catalogHash: createHash("sha256").update(JSON.stringify(ACHIEVEMENT_CATALOG)).digest("hex"),
      });
      archive.close();
    }
    const start = async (port) => {
      server = createUsageServer({ ...createPaletteServerOptions(fixture), edition });
      if (port)
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolve);
        });
      else await listenOnFetchPort(server);
      url = `http://127.0.0.1:${server.address().port}`;
    };
    await start();
    let expectedTotal = empty ? 0n : 226_100_242_800n;
    const snapshot = async () => {
      const response = await fetch(`${url}/api/achievements`);
      if (!response.ok) throw new Error(`Isolated achievement HTTP ${response.status}`);
      return response.json();
    };
    const waitForSnapshot = async (predicate = () => true) => {
      let latest;
      for (let attempt = 0; attempt < 200; attempt++) {
        latest = await snapshot();
        if (latest.state === "ready" && !latest.refreshing && predicate(latest)) return latest;
        await delay(30);
      }
      throw new Error(`Isolated achievement UI fixture did not settle: ${JSON.stringify(latest)}`);
    };
    const ready = async () => {
      const response = await fetch(`${url}/api/usage?preset=all`);
      if (!response.ok) throw new Error(`Isolated usage HTTP ${response.status}`);
      return waitForSnapshot(
        (value) => BigInt(value.rows.find((row) => row.id === "A01").observedValue) === expectedTotal,
      );
    };
    let closed = false;
    return {
      ...fixture,
      get server() {
        return server;
      },
      get url() {
        return url;
      },
      logFile,
      snapshot,
      waitForSnapshot,
      ready,
      async appendBatch(records) {
        await appendFile(logFile, records.map((record) => `${JSON.stringify(tokenEvent(record))}\n`).join(""));
        expectedTotal += records.reduce((sum, { total }) => sum + BigInt(total), 0n);
        return ready();
      },
      addGold() {
        return this.appendBatch([{ total: 5_100_000_000_000 }]);
      },
      async restart() {
        const port = server.address().port;
        await server.close();
        await start(port);
        return ready();
      },
      async close() {
        if (closed) return;
        await server.close();
        await fixture.close();
        closed = true;
      },
    };
  } catch (error) {
    if (server) await server.close();
    await fixture.close();
    throw error;
  }
}

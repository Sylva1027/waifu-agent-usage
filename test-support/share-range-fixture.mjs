import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createShareRangeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "share-ranges-"));
  const now = new Date(),
    at = now.getTime();
  const home = path.join(root, ".codex"),
    dir = path.join(home, "sessions");
  await mkdir(dir, { recursive: true });
  const eventTimes = [
    at - 10 * 86400000,
    at - 6 * 3600000,
    at - 60000,
    new Date(now.getFullYear() - 1, 5, 15).getTime(),
  ];
  for (const [i, time] of eventTimes.entries()) {
    const model = i === 2 ? "codex-auto-review" : "gpt-6-sol";
    const total = (i + 1) * 1000000;
    const rows = [
      {
        type: "session_meta",
        timestamp: new Date(time).toISOString(),
        payload: { id: "s" + i, source: "cli", cwd: root, model_provider: "openai" },
      },
      { type: "turn_context", timestamp: new Date(time).toISOString(), payload: { model } },
      {
        type: "event_msg",
        timestamp: new Date(time).toISOString(),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: total,
              input_tokens: total,
              cached_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
            },
          },
        },
      },
    ];
    if (i < 3)
      rows.push({
        type: "event_msg",
        timestamp: new Date(time).toISOString(),
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { window_minutes: 300, resets_at: Math.floor(time / 1000) + 7200, used_percent: 42 },
            secondary: {
              window_minutes: 10080,
              resets_at: Math.floor((i === 0 ? at - 9 * 86400000 : at + 86400000) / 1000),
              used_percent: 55,
            },
          },
        },
      });
    await writeFile(path.join(dir, i + ".jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  }
  return {
    root,
    now,
    options: {
      homeDir: root,
      env: {},
      extraHomes: home,
      importDirs: [],
      automaticDiscoveryEnabled: false,
      pricingRefreshSchedulerEnabled: false,
      databaseFile: path.join(root, "usage.sqlite"),
    },
    close: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

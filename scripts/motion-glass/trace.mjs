import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";

export async function recordTrace(page, path, action) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,cc,viz,gpu,benchmark",
      transferMode: "ReturnAsStream",
    });
    const sample = await action();
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    const { stream } = await done;
    const file = await open(path, "w");
    try {
      let chunk;
      do {
        chunk = await cdp.send("IO.read", { handle: stream });
        await file.writeFile(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
      } while (!chunk.eof);
    } finally {
      await file.close();
      await cdp.send("IO.close", { handle: stream });
    }
    return sample;
  } finally {
    await cdp.detach();
  }
}

export async function summarizeTrace(path) {
  const statesByFrame = new Map();
  let paintCount = 0;
  let paintMicros = 0;
  const { traceEvents } = JSON.parse(await readFile(path, "utf8"));
  for (const event of traceEvents) {
    if (event.name === "Paint" && event.ph === "X") {
      paintCount++;
      paintMicros += event.dur;
    }
    const report = event.args?.frame_reporter;
    if (event.name !== "PipelineReporter" || !report) continue;
    const key = `${report.frame_source}/${report.frame_sequence}`;
    if (!statesByFrame.has(key)) statesByFrame.set(key, new Set());
    statesByFrame.get(key).add(report.state.replace(/^STATE_/, ""));
  }
  assert.ok(statesByFrame.size > 0, `${path} contains no PipelineReporter frame sequences`);
  // Distinct sets are disjoint. A partial and a later full report can describe the same frame sequence.
  const stateSets = {};
  for (const states of statesByFrame.values()) {
    const key = [...states].sort().join("+");
    stateSets[key] = (stateSets[key] ?? 0) + 1;
  }
  return { sequences: statesByFrame.size, stateSets, paintCount, paintMs: paintMicros / 1000 };
}

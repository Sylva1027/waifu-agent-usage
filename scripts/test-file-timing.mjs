import path from "node:path";

export default async function* fileTiming(events) {
  for await (const { type, data } of events) {
    // The parent emits file completions immediately. Child summaries are buffered in declaration order.
    if (type !== "test:complete" || !data.file || data.entryFile !== undefined || data.nesting !== 0) continue;
    yield `test-file-timing ${JSON.stringify({
      file: path.relative(process.cwd(), data.file).split(path.sep).join("/"),
      durationMs: Math.round(data.details.duration_ms),
      completedAfterMs: Math.round(performance.now()),
      passed: data.details.passed,
    })}\n`;
  }
}

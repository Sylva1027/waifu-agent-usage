export const SHARE_METRIC_DEFINITIONS = Object.freeze(
  [
    ["cacheHit", "缓存命中", "Cache hit", "percent"],
    ["output", "输出", "Output", "tokens"],
    ["input", "输入", "Input", "tokens"],
    ["cached", "缓存读取", "Cache read", "tokens"],
    ["uncached", "未缓存输入", "Uncached input", "tokens"],
    ["reasoning", "推理", "Reasoning", "tokens"],
    ["sessions", "会话", "Sessions", "count"],
    ["models", "模型数量", "Models", "count"],
    ["harnesses", "Harness 数量", "Harnesses", "count"],
    ["providers", "模型厂商", "Model providers", "count"],
    ["repositories", "仓库数量", "Repositories", "count"],
    ["previous", "上期用量", "Previous usage", "tokens"],
    ["delta", "用量变化", "Usage change", "tokens"],
    ["growth", "用量增幅", "Usage growth", "percent"],
    ["topModel", "主力模型占比", "Top model share", "percent"],
    ["topThree", "Top 3 占比", "Top 3 share", "percent"],
    ["activeDays", "活跃天数", "Active days", "count"],
    ["dailyAverage", "日均用量", "Daily average", "tokens"],
    ["activeAverage", "活跃日均", "Active day average", "tokens"],
    ["peakDay", "单日峰值", "Peak day", "tokens"],
    ["peakHour", "单小时峰值", "Peak hour", "tokens"],
    ["maxSession", "最大会话", "Largest session", "tokens"],
    ["free", "免费用量", "Free usage", "tokens"],
    ["freeShare", "免费占比", "Free share", "percent"],
    ["review", "审核用量", "Review usage", "tokens"],
  ].map(([id, zh, en, format]) => Object.freeze({ id, zh, en, format })),
);

export function shareTokenParts(value) {
  if (!Number.isFinite(value)) return ["—", ""];
  const magnitude = Math.abs(value);
  const [divisor, unit] = magnitude >= 1e12 ? [1e12, "T"] : magnitude >= 1e9 ? [1e9, "B"] : [1e6, "M"];
  return [(value / divisor).toFixed(2), unit];
}

export function shareMetricParts(id, values) {
  const metric = SHARE_METRIC_DEFINITIONS.find((item) => item.id === id);
  const number = values[id];
  if (metric.format === "percent")
    return Number.isFinite(number)
      ? [Math.abs(number * 100) >= 1e6 ? (number * 100).toExponential(2) : (number * 100).toFixed(2), "%"]
      : ["—", ""];
  if (metric.format === "count") return [Number.isFinite(number) ? String(number) : "—", ""];
  return shareTokenParts(number);
}

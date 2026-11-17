// Required names and scalar defaults extracted from pricing.js; parity is checked by history-format-v3.test.js.
export const DEFAULT_USD_TO_CNY_RATE = 6.72;
export const MAX_PRICING_MODELS = 256;
export const REQUIRED_PRICING_MODELS = Object.freeze([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "claude-3-5-haiku",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "step-5-preview",
  "step-3.7-flash",
  "step-3.5-flash",
  "step-3.5-flash-2603",
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro-ultraspeed",
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "deepseek-flash",
  "deepseek-v4-pro",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.3-flashx",
  "glm-5.2",
  "glm-5.1",
  "glm-5-turbo",
  "glm-5",
  "glm-4.7",
  "glm-4.5-air",
  "glm-4.7-flashx",
  "glm-4.7-flash",
  "glm-4-plus",
  "glm-4-air-250414",
  "glm-4-airx",
  "glm-4-long",
  "glm-4-assistant",
  "glm-z1-air",
  "glm-z1-airx",
  "glm-z1-flashx",
  "glm-z1-flash",
  "glm-4-flashx-250414",
  "glm-4-flash-250414",
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent-0309",
  "grok-build-0.1",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.8-2.4t-a95b",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.7-flash",
  "glm-5.3-prime",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemma-4",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.7-highspeed",
  "minimax-m2.5",
  "minimax-m2.5-highspeed",
  "minimax-m2.1",
  "minimax-m2.1-highspeed",
  "minimax-m2",
  "muse-spark-1.3",
  "muse-spark-1.2",
  "muse-spark-1.1",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
]);
const RATE_FIELDS = ["input", "cachedInput", "cacheWrite", "output"];

/** @typedef {{ input: number, cachedInput: number, cacheWrite: number, output: number }} TokenRates */
/**
 * One model's per-million-token rates. Optional tiers are absent when a
 * provider quotes only one context or service tier.
 * @typedef {object} PriceModel
 * @property {TokenRates} short
 * @property {TokenRates} [long]
 * @property {{ short?: TokenRates, long?: TokenRates, shortLongOutput?: TokenRates }} [fast]
 * @property {TokenRates} [shortLongOutput]
 * @property {"USD" | "CNY"} [currency]
 * @property {string} [source]
 * @property {"5m"} [cacheWriteTtl]
 * @property {number} [standardContextLimit]
 * @property {number} [longContextThreshold]
 * @property {number} [outputThreshold]
 * @property {number} [offPeakMultiplier]
 * @property {string} [peakTimezone]
 * @property {ReadonlyArray<{ days: ReadonlyArray<number>, ranges: ReadonlyArray<ReadonlyArray<string>> }>} [peakWindows]
 */
/** @typedef {{ checkedAt: string, version: string, usdToCnyRate: number, models: Record<string, PriceModel> }} PricingCatalog */

/** @returns {TokenRates} */
function validateRates(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid rates for ${label}`);
  /** @type {TokenRates} */
  const rates = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  for (const field of RATE_FIELDS) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) {
      throw new Error(`Invalid ${field} rate for ${label}`);
    }
    rates[field] = value[field];
  }
  return rates;
}

function validatePeakWindows(value, label) {
  if (!Array.isArray(value) || !value.length) throw new Error(`Invalid peak windows for ${label}`);
  return value.map((window) => {
    const days = (window?.days || []).map(Number);
    if (!days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new Error(`Invalid peak days for ${label}`);
    }
    const ranges = (window?.ranges || []).map((range) => {
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !/^\d{2}:\d{2}$/.test(range[0]) ||
        !/^\d{2}:\d{2}$/.test(range[1])
      ) {
        throw new Error(`Invalid peak range for ${label}`);
      }
      return [range[0], range[1]];
    });
    if (!ranges.length) throw new Error(`Invalid peak ranges for ${label}`);
    return { days, ranges };
  });
}

export function validatePricingCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pricing must be an object.");
  const checkedAt = value.checkedAt;
  if (
    typeof checkedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) ||
    Number.isNaN(Date.parse(`${checkedAt}T00:00:00Z`)) ||
    new Date(`${checkedAt}T00:00:00Z`).toISOString().slice(0, 10) !== checkedAt
  ) {
    throw new Error("Pricing date must be a valid YYYY-MM-DD date.");
  }
  const models = value.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("Model prices are required.");
  const usdToCnyRate = value.usdToCnyRate === undefined ? DEFAULT_USD_TO_CNY_RATE : Number(value.usdToCnyRate);
  if (!Number.isFinite(usdToCnyRate) || usdToCnyRate <= 0)
    throw new Error("USD to CNY rate must be a positive number.");
  const keys = Object.keys(models);
  if (
    keys.length < REQUIRED_PRICING_MODELS.length ||
    REQUIRED_PRICING_MODELS.some((key) => !Object.hasOwn(models, key))
  ) {
    throw new Error("All built-in models must have prices.");
  }
  if (keys.length > MAX_PRICING_MODELS) throw new Error(`Pricing supports at most ${MAX_PRICING_MODELS} models.`);
  /** @type {Record<string, PriceModel>} */
  const normalized = {};
  for (const model of keys.sort()) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(model)) throw new Error(`Invalid model name: ${model}`);
    const entry = models[model];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid rates for ${model}`);
    const currency = entry.currency === undefined ? "USD" : entry.currency;
    if (currency !== "USD" && currency !== "CNY") throw new Error(`Invalid currency for ${model}`);
    const short = validateRates(entry.short, `${model} short`);
    const result = { currency, short };
    if (entry.cacheWriteTtl !== undefined) {
      if (entry.cacheWriteTtl !== "5m") throw new Error(`Unsupported cache write TTL for ${model}`);
      result.cacheWriteTtl = entry.cacheWriteTtl;
    }
    if (entry.standardContextLimit !== undefined) {
      if (!Number.isInteger(entry.standardContextLimit) || entry.standardContextLimit <= 0)
        throw new Error(`Invalid standardContextLimit for ${model}`);
      result.standardContextLimit = entry.standardContextLimit;
    }
    result.long = entry.long === undefined ? { ...short } : validateRates(entry.long, `${model} long`);
    if (entry.shortLongOutput !== undefined) {
      result.shortLongOutput = validateRates(entry.shortLongOutput, `${model} shortLongOutput`);
    }
    if (entry.fast !== undefined) {
      const fast = entry.fast;
      if (!fast || typeof fast !== "object" || Array.isArray(fast)) throw new Error(`Invalid fast rates for ${model}`);
      const fastRates = { short: validateRates(fast.short, `${model} fast short`) };
      if (fast.long !== undefined) fastRates.long = validateRates(fast.long, `${model} fast long`);
      if (fast.shortLongOutput !== undefined)
        fastRates.shortLongOutput = validateRates(fast.shortLongOutput, `${model} fast shortLongOutput`);
      result.fast = fastRates;
    }
    if (entry.longContextThreshold !== undefined) {
      const threshold = Number(entry.longContextThreshold);
      if (!Number.isInteger(threshold) || threshold <= 0) throw new Error(`Invalid longContextThreshold for ${model}`);
      result.longContextThreshold = threshold;
    }
    if (entry.outputThreshold !== undefined) {
      const threshold = Number(entry.outputThreshold);
      if (!Number.isInteger(threshold) || threshold <= 0) throw new Error(`Invalid outputThreshold for ${model}`);
      result.outputThreshold = threshold;
    }
    if (entry.offPeakMultiplier !== undefined) {
      const multiplier = Number(entry.offPeakMultiplier);
      if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1)
        throw new Error(`Invalid offPeakMultiplier for ${model}`);
      result.offPeakMultiplier = multiplier;
    }
    if (entry.peakWindows !== undefined) {
      result.peakWindows = validatePeakWindows(entry.peakWindows, model);
      result.peakTimezone =
        typeof entry.peakTimezone === "string" && entry.peakTimezone ? entry.peakTimezone : "Asia/Shanghai";
    }
    if (entry.source !== undefined) {
      if (typeof entry.source !== "string" || !/^https?:\/\//.test(entry.source))
        throw new Error(`Invalid source for ${model}`);
      result.source = entry.source;
    }
    normalized[model] = result;
  }
  return { checkedAt, usdToCnyRate, models: normalized };
}

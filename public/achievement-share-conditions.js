// Share-card wording separates the milestone from its qualifiers at each tier.
export const ACHIEVEMENT_SHARE_CONDITIONS = {
  A01: {
    zh: [["累计 500 亿 Token"], ["累计 2000 亿 Token"], ["累计 5 万亿 Token"]],
    en: [["50B tokens in total"], ["200B tokens in total"], ["5T tokens in total"]],
  },
  A06: {
    zh: [
      ["100 亿 Token", "免费模型的累计用量"],
      ["1000 亿 Token", "免费模型的累计用量"],
      ["1 万亿 Token", "免费模型的累计用量"],
    ],
    en: [
      ["10B tokens", "Across free models"],
      ["100B tokens", "Across free models"],
      ["1T tokens", "Across free models"],
    ],
  },
  A07: {
    zh: [
      ["用过 10 种模型", "每种累计至少 1 亿 Token"],
      ["用过 30 种模型", "每种累计至少 1 亿 Token"],
      ["用过 50 种模型", "每种累计至少 1 亿 Token"],
    ],
    en: [
      ["10 models used", "At least 100M tokens per model"],
      ["30 models used", "At least 100M tokens per model"],
      ["50 models used", "At least 100M tokens per model"],
    ],
  },
  A08: {
    zh: [
      ["用过 3 家厂商的模型", "每家累计至少 10 亿 Token"],
      ["用过 5 家厂商的模型", "每家累计至少 10 亿 Token"],
      ["用过 10 家厂商的模型", "每家累计至少 10 亿 Token"],
    ],
    en: [
      ["Models from 3 providers", "At least 1B tokens per provider"],
      ["Models from 5 providers", "At least 1B tokens per provider"],
      ["Models from 10 providers", "At least 1B tokens per provider"],
    ],
  },
  A09: {
    zh: [
      ["用过 2 种 Harness", "每种累计至少 10 亿 Token"],
      ["用过 4 种 Harness", "每种累计至少 10 亿 Token"],
      ["用过 7 种 Harness", "每种累计至少 10 亿 Token"],
    ],
    en: [
      ["2 harnesses used", "At least 1B tokens per harness"],
      ["4 harnesses used", "At least 1B tokens per harness"],
      ["7 harnesses used", "At least 1B tokens per harness"],
    ],
  },
  A10: {
    zh: [
      ["深度使用 3 种模型", "每种累计至少 10 亿 Token"],
      ["深度使用 7 种模型", "每种累计至少 10 亿 Token"],
      ["深度使用 15 种模型", "每种累计至少 10 亿 Token"],
    ],
    en: [
      ["3 models used", "At least 1B tokens per model"],
      ["7 models used", "At least 1B tokens per model"],
      ["15 models used", "At least 1B tokens per model"],
    ],
  },
  A11: {
    zh: [
      ["同一模型，2 种 Harness", "每种 Harness 累计至少 10 亿 Token"],
      ["同一模型，4 种 Harness", "每种 Harness 累计至少 10 亿 Token"],
      ["同一模型，6 种 Harness", "每种 Harness 累计至少 10 亿 Token"],
    ],
    en: [
      ["One model, 2 harnesses", "At least 1B tokens per harness"],
      ["One model, 4 harnesses", "At least 1B tokens per harness"],
      ["One model, 6 harnesses", "At least 1B tokens per harness"],
    ],
  },
  A12: {
    zh: [
      ["一个仓库，5 种模型", "每种模型累计至少 10 亿 Token"],
      ["一个仓库，7 种模型", "每种模型累计至少 10 亿 Token"],
      ["一个仓库，12 种模型", "每种模型累计至少 10 亿 Token"],
    ],
    en: [
      ["One repository, 5 models", "At least 1B tokens per model in that repository"],
      ["One repository, 7 models", "At least 1B tokens per model in that repository"],
      ["One repository, 12 models", "At least 1B tokens per model in that repository"],
    ],
  },
  A13: {
    zh: [
      ["累计活跃 30 天", "每天至少 1000 万 Token"],
      ["累计活跃 180 天", "每天至少 1000 万 Token"],
      ["累计活跃 365 天", "每天至少 1000 万 Token"],
    ],
    en: [
      ["30 active days in total", "At least 10M tokens on each of those days"],
      ["180 active days in total", "At least 10M tokens on each of those days"],
      ["365 active days in total", "At least 10M tokens on each of those days"],
    ],
  },
  A14: {
    zh: [
      ["连续 7 天", "每天至少 1000 万 Token"],
      ["连续 30 天", "每天至少 1000 万 Token"],
      ["连续 365 天", "每天至少 1000 万 Token"],
    ],
    en: [
      ["7 days in a row", "At least 10M tokens every day"],
      ["30 days in a row", "At least 10M tokens every day"],
      ["365 days in a row", "At least 10M tokens every day"],
    ],
  },
  A16: {
    zh: [
      ["累计活跃 3 个月", "每月至少有 10 天用量达到 1000 万 Token"],
      ["累计活跃 12 个月", "每月至少有 10 天用量达到 1000 万 Token"],
      ["累计活跃 24 个月", "每月至少有 10 天用量达到 1000 万 Token"],
    ],
    en: [
      ["3 active months", "At least 10 days per month with 10M tokens or more each day"],
      ["12 active months", "At least 10 days per month with 10M tokens or more each day"],
      ["24 active months", "At least 10 days per month with 10M tokens or more each day"],
    ],
  },
  A18: {
    zh: [
      ["同一仓库累计活跃 30 天", "每天至少 1 亿 Token"],
      ["同一仓库累计活跃 90 天", "每天至少 1 亿 Token"],
      ["同一仓库累计活跃 180 天", "每天至少 1 亿 Token"],
    ],
    en: [
      ["30 active days in one repository", "At least 100M tokens on each of those days"],
      ["90 active days in one repository", "At least 100M tokens on each of those days"],
      ["180 active days in one repository", "At least 100M tokens on each of those days"],
    ],
  },
  A19: {
    zh: [
      ["1 亿 Token", "一天内的用量"],
      ["10 亿 Token", "一天内的用量"],
      ["100 亿 Token", "一天内的用量"],
    ],
    en: [
      ["100M tokens", "In a single day"],
      ["1B tokens", "In a single day"],
      ["10B tokens", "In a single day"],
    ],
  },
  A23: {
    zh: [
      ["5 亿 Token", "一个会话的累计用量"],
      ["10 亿 Token", "一个会话的累计用量"],
      ["50 亿 Token", "一个会话的累计用量"],
    ],
    en: [
      ["500M tokens", "In a single session"],
      ["1B tokens", "In a single session"],
      ["5B tokens", "In a single session"],
    ],
  },
  A24: {
    zh: [
      ["用过 5 个仓库", "每个仓库累计至少 10 亿 Token"],
      ["用过 10 个仓库", "每个仓库累计至少 10 亿 Token"],
      ["用过 30 个仓库", "每个仓库累计至少 10 亿 Token"],
    ],
    en: [
      ["5 repositories used", "At least 1B tokens per repository"],
      ["10 repositories used", "At least 1B tokens per repository"],
      ["30 repositories used", "At least 1B tokens per repository"],
    ],
  },
  A28: {
    zh: [
      ["一天用过 4 种模型", "每种当天至少 1 亿 Token"],
      ["一天用过 7 种模型", "每种当天至少 1 亿 Token"],
      ["一天用过 10 种模型", "每种当天至少 1 亿 Token"],
    ],
    en: [
      ["4 models in one day", "At least 100M tokens per model that day"],
      ["7 models in one day", "At least 100M tokens per model that day"],
      ["10 models in one day", "At least 100M tokens per model that day"],
    ],
  },
  A29: {
    zh: [
      ["一周用过 3 种 Harness", "每种当周至少 10 亿 Token"],
      ["一周用过 5 种 Harness", "每种当周至少 10 亿 Token"],
      ["一周用过 7 种 Harness", "每种当周至少 10 亿 Token"],
    ],
    en: [
      ["3 harnesses in one week", "At least 1B tokens per harness that week"],
      ["5 harnesses in one week", "At least 1B tokens per harness that week"],
      ["7 harnesses in one week", "At least 1B tokens per harness that week"],
    ],
  },
  A30: {
    zh: [
      ["同一模型累计用了 7 天", "每天至少 1 亿 Token"],
      ["同一模型累计用了 15 天", "每天至少 1 亿 Token"],
      ["同一模型累计用了 45 天", "每天至少 1 亿 Token"],
    ],
    en: [
      ["7 days with one model", "At least 100M tokens on each of those days"],
      ["15 days with one model", "At least 100M tokens on each of those days"],
      ["45 days with one model", "At least 100M tokens on each of those days"],
    ],
  },
  A31: {
    zh: [["首次产生 Token 用量"]],
    en: [["First token usage recorded"]],
  },
  A32: {
    zh: [["累计 100 亿 Token"]],
    en: [["10B tokens in total"]],
  },
  A33: {
    zh: [["同一会话用了 2 种模型", "每种至少 1 亿 Token"]],
    en: [["2 models in one session", "At least 100M tokens per model in that session"]],
  },
  A36: {
    zh: [["时隔至少 30 天重逢", "再次使用同一模型，当天至少 1 亿 Token"]],
    en: [["Back after 30+ days", "Used the same model again, with at least 100M tokens that day"]],
  },
  A38: {
    zh: [["跨年两天都在用", "12 月 31 日和次年 1 月 1 日各至少 100 万 Token"]],
    en: [["Active over New Year", "At least 1M tokens on December 31 and again the following January 1"]],
  },
  A39: {
    zh: [["2 月 29 日也在用", "当天至少 100 万 Token"]],
    en: [["Active on February 29", "At least 1M tokens that day"]],
  },
  A43: {
    zh: [
      ["1 份用量战报", "复制或保存，每份的用量数据都不同"],
      ["10 份用量战报", "复制或保存，每份的用量数据都不同"],
      ["50 份用量战报", "复制或保存，每份的用量数据都不同"],
    ],
    en: [
      ["1 usage card", "Copied or saved, each with different usage data"],
      ["10 usage cards", "Copied or saved, each with different usage data"],
      ["50 usage cards", "Copied or saved, each with different usage data"],
    ],
  },
  A44: {
    zh: [["用过全部 8 款角色皮肤"]],
    en: [["All 8 character skins used"]],
  },
  A46: {
    zh: [["成功恢复历史备份"]],
    en: [["Restored a history backup"]],
  },
  A53: {
    zh: [
      ["10 亿 Token", "同一个模型的累计用量"],
      ["50 亿 Token", "同一个模型的累计用量"],
      ["150 亿 Token", "同一个模型的累计用量"],
    ],
    en: [
      ["1B tokens", "Total usage with one model"],
      ["5B tokens", "Total usage with one model"],
      ["15B tokens", "Total usage with one model"],
    ],
  },
  A54: {
    zh: [
      ["100 亿 Token", "同一种 Harness 的累计用量"],
      ["2000 亿 Token", "同一种 Harness 的累计用量"],
      ["1 万亿 Token", "同一种 Harness 的累计用量"],
    ],
    en: [
      ["10B tokens", "Total usage with one harness"],
      ["200B tokens", "Total usage with one harness"],
      ["1T tokens", "Total usage with one harness"],
    ],
  },
  A55: {
    zh: [
      ["10 亿 Token", "同一个仓库的累计用量"],
      ["500 亿 Token", "同一个仓库的累计用量"],
      ["1 万亿 Token", "同一个仓库的累计用量"],
    ],
    en: [
      ["1B tokens", "Total usage in one repository"],
      ["50B tokens", "Total usage in one repository"],
      ["1T tokens", "Total usage in one repository"],
    ],
  },
  A56: {
    zh: [
      ["累计达标 5 天", "这些天的单日用量均达到 10 亿 Token"],
      ["累计达标 10 天", "这些天的单日用量均达到 10 亿 Token"],
      ["累计达标 30 天", "这些天的单日用量均达到 10 亿 Token"],
    ],
    en: [
      ["5 qualifying days in total", "At least 1B tokens on each of those days"],
      ["10 qualifying days in total", "At least 1B tokens on each of those days"],
      ["30 qualifying days in total", "At least 1B tokens on each of those days"],
    ],
  },
  A58: {
    zh: [
      ["30 亿 Token", "一个自然月内的用量"],
      ["100 亿 Token", "一个自然月内的用量"],
      ["1000 亿 Token", "一个自然月内的用量"],
    ],
    en: [
      ["3B tokens", "In one calendar month"],
      ["10B tokens", "In one calendar month"],
      ["100B tokens", "In one calendar month"],
    ],
  },
  A59: {
    zh: [
      ["10 亿 Token", "一个自然周内的用量"],
      ["30 亿 Token", "一个自然周内的用量"],
      ["100 亿 Token", "一个自然周内的用量"],
    ],
    en: [
      ["1B tokens", "In one calendar week"],
      ["3B tokens", "In one calendar week"],
      ["10B tokens", "In one calendar week"],
    ],
  },
  A63: {
    zh: [
      ["一天用过 3 种 Harness", "每种当天至少 1 亿 Token"],
      ["一天用过 5 种 Harness", "每种当天至少 1 亿 Token"],
      ["一天用过 7 种 Harness", "每种当天至少 1 亿 Token"],
    ],
    en: [
      ["3 harnesses in one day", "At least 100M tokens per harness that day"],
      ["5 harnesses in one day", "At least 100M tokens per harness that day"],
      ["7 harnesses in one day", "At least 100M tokens per harness that day"],
    ],
  },
  A65: {
    zh: [
      ["累计达标 3 个月", "每月至少有 20 天用量达到 1 亿 Token"],
      ["累计达标 6 个月", "每月至少有 20 天用量达到 1 亿 Token"],
      ["累计达标 12 个月", "每月至少有 20 天用量达到 1 亿 Token"],
    ],
    en: [
      ["3 qualifying months", "At least 20 days per month with 100M tokens or more each day"],
      ["6 qualifying months", "At least 20 days per month with 100M tokens or more each day"],
      ["12 qualifying months", "At least 20 days per month with 100M tokens or more each day"],
    ],
  },
  A69: {
    zh: [["累计 1000 亿 Token"]],
    en: [["100B tokens in total"]],
  },
  A70: {
    zh: [["累计 1 万亿 Token"]],
    en: [["1T tokens in total"]],
  },
  A71: {
    zh: [["累计 10 万亿 Token"]],
    en: [["10T tokens in total"]],
  },
  A73: {
    zh: [["集齐全部铜级成就"]],
    en: [["Every bronze achievement earned"]],
  },
  A74: {
    zh: [["集齐全部银级成就"]],
    en: [["Every silver achievement earned"]],
  },
  A75: {
    zh: [["集齐全部金级成就"]],
    en: [["Every gold achievement earned"]],
  },
  A76: {
    zh: [["集齐其余 11 项故事成就"]],
    en: [["Earned all 11 other Stories achievements"]],
  },
};

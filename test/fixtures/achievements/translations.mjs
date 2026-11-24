// Frozen bilingual product copy; preview controls are intentionally excluded.
export const englishAchievements = {
  A01: {
    name: "Token Expedition",
    description: "Use 50B / 200B / 5T tokens in total.",
  },
  A06: {
    name: "Freebie King",
    description: "Use 10B / 100B / 1T tokens with free models.",
  },
  A07: {
    name: "You're All My Wings",
    description: "Use 10 / 30 / 50 models, with 100M tokens each.",
  },
  A08: {
    name: "Lucky You",
    description: "Use models from 3 / 5 / 10 providers, with 1B tokens per provider.",
  },
  A09: {
    name: "The King's Treasury",
    description: "Use 2 / 4 / 7 harnesses, with 1B tokens each.",
  },
  A10: {
    name: "Extended Test Drive",
    description: "Use 3 / 7 / 15 models, with 1B tokens each.",
  },
  A11: {
    name: "Still My Favorite",
    description: "Use one model via 2 / 4 / 6 harnesses, with 1B tokens per harness.",
  },
  A12: {
    name: "Let's Sync Up",
    description: "Use 5 / 7 / 12 models in one repository, with 1B tokens per model.",
  },
  A13: {
    name: "Little by Little",
    description: "Use 10M tokens a day on 30 / 180 / 365 days in total.",
  },
  A14: {
    name: "See You Tomorrow",
    description: "Use 10M tokens a day for 7 / 30 / 365 consecutive days.",
  },
  A16: {
    name: "Month After Month",
    description: "Log 3 / 12 / 24 months, each with at least 10 days at 10M tokens a day.",
  },
  A18: {
    name: "Moving In?",
    description: "Use 100M tokens a day in one repository on 30 / 90 / 180 days in total.",
  },
  A19: {
    name: "Getting Carried Away",
    description: "Use 100M / 1B / 10B tokens in one day.",
  },
  A23: {
    name: "Where Was I...?",
    description: "Use 500M / 1B / 5B tokens in one session.",
  },
  A24: {
    name: "Branching Out",
    description: "Use 1B tokens in each of 5 / 10 / 30 repositories.",
  },
  A28: {
    name: "In Good Company",
    description: "Use 4 / 7 / 10 models in one day, with 100M tokens each that day.",
  },
  A29: {
    name: "A Meeting of Minds",
    description: "Use 3 / 5 / 7 harnesses in one week, with 1B tokens each that week.",
  },
  A30: {
    name: "Old Reliable",
    description: "Use 100M tokens a day with one model on 7 / 15 / 45 days in total.",
  },
  A31: {
    name: "First Steps",
    description: "Record your first token usage.",
  },
  A32: {
    name: "10B Milestone",
    description: "Use 10B tokens in total.",
  },
  A33: {
    name: "I Beg to Differ",
    description: "Use 2 models in one session, with 100M tokens each.",
  },
  A36: {
    name: "Hello, Old Friend",
    description: "Return to a model after at least 30 days away; use 100M tokens that day.",
  },
  A38: {
    name: "See You Next Year",
    description: "Use 1M tokens on both December 31 and the following January 1.",
  },
  A39: {
    name: "Leap Day Visitor",
    description: "Use 1M tokens on February 29.",
  },
  A43: {
    name: "Pics or It Didn't Happen",
    description: "Copy or save 1 / 10 / 50 usage cards, each with different data.",
  },
  A44: {
    name: "I'll Take Them All!",
    description: "Use 8 character skins.",
  },
  A46: {
    name: "Gift of the Bronze Dragonflight",
    description: "Successfully restore a history backup.",
  },
  A53: {
    name: "You Know Too Much",
    description: "Use 1B / 5B / 15B tokens with one model.",
  },
  A54: {
    name: "Too Lazy to Switch",
    description: "Use 10B / 200B / 1T tokens with one harness.",
  },
  A55: {
    name: "Down the Rabbit Hole",
    description: "Use 1B / 50B / 1T tokens in one repository.",
  },
  A56: {
    name: "A Billion a Day",
    description: "Use 1B tokens a day on 5 / 10 / 30 days in total.",
  },
  A58: {
    name: "Tokens for Days",
    description: "Use 3B / 10B / 100B tokens in one calendar month.",
  },
  A59: {
    name: "Tokens to Spare",
    description: "Use 1B / 3B / 10B tokens in one calendar week.",
  },
  A63: {
    name: "Alt + Tab",
    description: "Use 3 / 5 / 7 harnesses in one day, with 100M tokens each that day.",
  },
  A65: {
    name: "Quite the Regular",
    description: "Log 3 / 6 / 12 months, each with at least 20 days at 100M tokens a day.",
  },
  A69: {
    name: "100B Milestone",
    description: "Use 100B tokens in total.",
  },
  A70: {
    name: "1T Milestone",
    description: "Use 1T tokens in total.",
  },
  A71: {
    name: "10T Milestone",
    description: "Use 10T tokens in total.",
  },
  A73: {
    name: "Bronze Slam",
    description: "Earn every bronze-tier achievement.",
  },
  A74: {
    name: "Silver Slam",
    description: "Earn every silver-tier achievement.",
  },
  A75: {
    name: "Gold Slam",
    description: "Earn every gold-tier achievement.",
  },
  A76: {
    name: "What a Long, Strange Trip It's Been",
    description: "Earn every other achievement in Stories.",
  },
};

export const interfaceCopy = {
  "zh-CN": {
    title: "成就",
    search: "搜索成就",
    searchPlaceholder: "搜索成就",
    status: "获得状态",
    categories: "成就分类",
    statuses: { all: "全部状态", earned: "已获得", locked: "未获得" },
    grades: { bronze: "铜", silver: "银", gold: "金" },
    view: (name) => `查看 ${name}`,
    details: (name) => `${name}详情`,
    progress: (name) => `${name}进度`,
    previewGrade: (grade, threshold) => `预览${grade}章，${threshold}`,
    tier: (grade, threshold, date) => `${grade}级 ${threshold}，${date || "未获得"}`,
    earned: (date) => `获得日期 ${date}`,
    updated: (date) => `最近更新 ${date}`,
    notEarned: "尚未获得",
    noRecent: "还没有近期成就",
    noRecentHint: "新的收获会出现在这里。",
    noMatches: "没有匹配的成就",
    noMatchesHint: "试试其他分类或搜索词。",
  },
  en: {
    title: "Achievements",
    search: "Search achievements",
    searchPlaceholder: "Search",
    status: "Achievement status",
    categories: "Achievement categories",
    statuses: { all: "All", earned: "Earned", locked: "Not earned" },
    grades: { bronze: "Bronze", silver: "Silver", gold: "Gold" },
    view: (name) => `View ${name}`,
    details: (name) => `${name} details`,
    progress: (name) => `${name} progress`,
    previewGrade: (grade, threshold) => `Preview ${grade.toLowerCase()} badge, ${threshold}`,
    tier: (grade, threshold, date) => `${grade} tier, ${threshold}, ${date || "Not earned"}`,
    earned: (date) => `Earned ${date}`,
    updated: (date) => `Updated ${date}`,
    notEarned: "Not yet earned",
    noRecent: "No recent achievements",
    noRecentHint: "Your next milestones will appear here.",
    noMatches: "No matching achievements",
    noMatchesHint: "Try another category or search term.",
  },
};

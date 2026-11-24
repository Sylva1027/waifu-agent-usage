const achievementPreview = {
  medals: {
    A01: "./art/medals/A01-silver.webp",
    A06: "./art/medals/A06-silver.webp",
    A07: "./art/medals/A07-silver.webp",
    A08: "./art/medals/A08-silver.webp",
    A09: "./art/medals/A09-silver.webp",
    A10: "./art/medals/A10-silver.webp",
    A11: "./art/medals/A11-silver.webp",
    A12: "./art/medals/A12-silver.webp",
    A13: "./art/medals/A13-silver.webp",
    A14: "./art/medals/A14-silver.png",
    A16: "./art/medals/A16-silver.webp",
    A18: "./art/medals/A18-silver.webp",
    A19: "./art/medals/A19-silver.webp",
    A23: "./art/medals/A23-silver.webp",
    A24: "./art/medals/A24-silver.webp",
    A28: "./art/medals/A28-silver.webp",
    A29: "./art/medals/A29-silver.webp",
    A30: "./art/medals/A30-silver.webp",
    A31: "./art/medals/A31-stone.webp",
    A32: "./art/medals/A32-stone.png",
    A33: "./art/medals/A33-stone.webp",
    A36: "./art/medals/A36-stone.png",
    A38: "./art/medals/A38-stone.webp",
    A39: "./art/medals/A39-stone.webp",
    A43: "./art/medals/A43-silver.webp",
    A44: "./art/medals/A44-stone.webp",
    A46: "./art/medals/A46-stone.webp",
    A53: "./art/medals/A53-silver.webp",
    A54: "./art/medals/A54-silver.webp",
    A55: "./art/medals/A55-silver.webp",
    A56: "./art/medals/A56-silver.webp",
    A58: "./art/medals/A58-silver.webp",
    A59: "./art/medals/A59-silver.webp",
    A63: "./art/medals/A63-silver.webp",
    A65: "./art/medals/A65-silver.webp",
    A69: "./art/medals/A69-stone.webp",
    A70: "./art/medals/A70-stone.webp",
    A71: "./art/medals/A71-stone.webp",
    A73: "./art/medals/A73-stone.webp",
    A74: "./art/medals/A74-stone.webp",
    A75: "./art/medals/A75-stone.webp",
    A76: "./art/medals/A76-stone.webp",
  },
  examples: [
    {
      id: "A01",
      grade: "silver",
      zh: {
        title: "Token 远征",
        detail: "国家电网合作伙伴",
        conditions: [
          {
            fact: "累计 500 亿 Token",
          },
          {
            fact: "累计 2000 亿 Token",
          },
          {
            fact: "累计 5 万亿 Token",
          },
        ],
      },
      en: {
        title: "Token Expedition",
        detail: "Proud partner of FPL.",
        conditions: [
          {
            fact: "50B tokens in total",
          },
          {
            fact: "200B tokens in total",
          },
          {
            fact: "5T tokens in total",
          },
        ],
      },
    },
    {
      id: "A06",
      grade: "silver",
      zh: {
        title: "薅羊毛大王",
        detail: "AI 云厂最痛恨之人",
        conditions: [
          {
            fact: "100 亿 Token",
            qualifier: "免费模型的累计用量",
          },
          {
            fact: "1000 亿 Token",
            qualifier: "免费模型的累计用量",
          },
          {
            fact: "1 万亿 Token",
            qualifier: "免费模型的累计用量",
          },
        ],
      },
      en: {
        title: "Freebie King",
        detail: "Not welcomed by NeoCloud.",
        conditions: [
          {
            fact: "10B tokens",
            qualifier: "Across free models",
          },
          {
            fact: "100B tokens",
            qualifier: "Across free models",
          },
          {
            fact: "1T tokens",
            qualifier: "Across free models",
          },
        ],
      },
    },
    {
      id: "A07",
      grade: "silver",
      zh: {
        title: "你们都是我的翅膀",
        detail: "“妳...妳们是...我的翅膀！” - 超时空要塞 Frontier",
        conditions: [
          {
            fact: "用过 10 种模型",
            qualifier: "每种累计至少 1 亿 Token",
          },
          {
            fact: "用过 30 种模型",
            qualifier: "每种累计至少 1 亿 Token",
          },
          {
            fact: "用过 50 种模型",
            qualifier: "每种累计至少 1 亿 Token",
          },
        ],
      },
      en: {
        title: "You're All My Wings",
        detail: "“It's okay to love them both. I did.” — Katherine Pierce",
        conditions: [
          {
            fact: "10 models used",
            qualifier: "At least 100M tokens per model",
          },
          {
            fact: "30 models used",
            qualifier: "At least 100M tokens per model",
          },
          {
            fact: "50 models used",
            qualifier: "At least 100M tokens per model",
          },
        ],
      },
    },
    {
      id: "A08",
      grade: "silver",
      zh: {
        title: "福气不小",
        detail: "“两大强国侍候着我一个人，这点福气还小吗？” - 茶馆",
        conditions: [
          {
            fact: "用过 3 家厂商的模型",
            qualifier: "每家累计至少 10 亿 Token",
          },
          {
            fact: "用过 5 家厂商的模型",
            qualifier: "每家累计至少 10 亿 Token",
          },
          {
            fact: "用过 10 家厂商的模型",
            qualifier: "每家累计至少 10 亿 Token",
          },
        ],
      },
      en: {
        title: "Lucky You",
        detail: "“Hooray! People are paying attention to me!” — Zoidberg",
        conditions: [
          {
            fact: "Models from 3 providers",
            qualifier: "At least 1B tokens per provider",
          },
          {
            fact: "Models from 5 providers",
            qualifier: "At least 1B tokens per provider",
          },
          {
            fact: "Models from 10 providers",
            qualifier: "At least 1B tokens per provider",
          },
        ],
      },
    },
    {
      id: "A09",
      grade: "silver",
      zh: {
        title: "王之宝库",
        detail: "“听本王的命令！全部炮门，解锁！” - Fate/Grand Order",
        conditions: [
          {
            fact: "用过 2 种 Harness",
            qualifier: "每种累计至少 10 亿 Token",
          },
          {
            fact: "用过 4 种 Harness",
            qualifier: "每种累计至少 10 亿 Token",
          },
          {
            fact: "用过 7 种 Harness",
            qualifier: "每种累计至少 10 亿 Token",
          },
        ],
      },
      en: {
        title: "The King's Treasury",
        detail: "“Heed my voice! Ready the ballistas!” — Fate/Grand Order",
        conditions: [
          {
            fact: "2 harnesses used",
            qualifier: "At least 1B tokens per harness",
          },
          {
            fact: "4 harnesses used",
            qualifier: "At least 1B tokens per harness",
          },
          {
            fact: "7 harnesses used",
            qualifier: "At least 1B tokens per harness",
          },
        ],
      },
    },
    {
      id: "A10",
      grade: "silver",
      zh: {
        title: "深度试驾",
        detail: "有时候，我的天才程度……连我自己都感到害怕。 - 杰里米·克拉克森",
        conditions: [
          {
            fact: "深度使用 3 种模型",
            qualifier: "每种累计至少 10 亿 Token",
          },
          {
            fact: "深度使用 7 种模型",
            qualifier: "每种累计至少 10 亿 Token",
          },
          {
            fact: "深度使用 15 种模型",
            qualifier: "每种累计至少 10 亿 Token",
          },
        ],
      },
      en: {
        title: "Extended Test Drive",
        detail: "“Sometimes my genius is... it's almost frightening.” - Jeremy Clarkson",
        conditions: [
          {
            fact: "3 models used",
            qualifier: "At least 1B tokens per model",
          },
          {
            fact: "7 models used",
            qualifier: "At least 1B tokens per model",
          },
          {
            fact: "15 models used",
            qualifier: "At least 1B tokens per model",
          },
        ],
      },
    },
    {
      id: "A11",
      grade: "silver",
      zh: {
        title: "还是你最好",
        detail: "思钱想厚，还是你最好",
        conditions: [
          {
            fact: "同一模型，2 种 Harness",
            qualifier: "每种 Harness 累计至少 10 亿 Token",
          },
          {
            fact: "同一模型，4 种 Harness",
            qualifier: "每种 Harness 累计至少 10 亿 Token",
          },
          {
            fact: "同一模型，6 种 Harness",
            qualifier: "每种 Harness 累计至少 10 亿 Token",
          },
        ],
      },
      en: {
        title: "Still My Favorite",
        detail: "I've weighed my heart and my wallet. You're still the one.",
        conditions: [
          {
            fact: "One model, 2 harnesses",
            qualifier: "At least 1B tokens per harness",
          },
          {
            fact: "One model, 4 harnesses",
            qualifier: "At least 1B tokens per harness",
          },
          {
            fact: "One model, 6 harnesses",
            qualifier: "At least 1B tokens per harness",
          },
        ],
      },
    },
    {
      id: "A12",
      grade: "silver",
      zh: {
        title: "下午咱们拉个会",
        detail: "Call一下？",
        conditions: [
          {
            fact: "一个仓库，5 种模型",
            qualifier: "每种模型累计至少 10 亿 Token",
          },
          {
            fact: "一个仓库，7 种模型",
            qualifier: "每种模型累计至少 10 亿 Token",
          },
          {
            fact: "一个仓库，12 种模型",
            qualifier: "每种模型累计至少 10 亿 Token",
          },
        ],
      },
      en: {
        title: "Let's Sync Up",
        detail: "Quick call?",
        conditions: [
          {
            fact: "One repository, 5 models",
            qualifier: "At least 1B tokens per model in that repository",
          },
          {
            fact: "One repository, 7 models",
            qualifier: "At least 1B tokens per model in that repository",
          },
          {
            fact: "One repository, 12 models",
            qualifier: "At least 1B tokens per model in that repository",
          },
        ],
      },
    },
    {
      id: "A13",
      grade: "silver",
      zh: {
        title: "日积月累",
        detail: "居然是JVAV高手",
        conditions: [
          {
            fact: "累计活跃 30 天",
            qualifier: "每天至少 1000 万 Token",
          },
          {
            fact: "累计活跃 180 天",
            qualifier: "每天至少 1000 万 Token",
          },
          {
            fact: "累计活跃 365 天",
            qualifier: "每天至少 1000 万 Token",
          },
        ],
      },
      en: {
        title: "Little by Little",
        detail:
          "I reverse-engineered the Linux source with REA, rewrote it in Rust, then open-sourced the whole thing.",
        conditions: [
          {
            fact: "30 active days in total",
            qualifier: "At least 10M tokens on each of those days",
          },
          {
            fact: "180 active days in total",
            qualifier: "At least 10M tokens on each of those days",
          },
          {
            fact: "365 active days in total",
            qualifier: "At least 10M tokens on each of those days",
          },
        ],
      },
    },
    {
      id: "A14",
      grade: "silver",
      zh: {
        title: "明天见",
        detail: "“明天见！” - 金针菇",
        conditions: [
          {
            fact: "连续 7 天",
            qualifier: "每天至少 1000 万 Token",
          },
          {
            fact: "连续 30 天",
            qualifier: "每天至少 1000 万 Token",
          },
          {
            fact: "连续 365 天",
            qualifier: "每天至少 1000 万 Token",
          },
        ],
      },
      en: {
        title: "See You Tomorrow",
        detail: "“See you tomorrow!” — Corn",
        conditions: [
          {
            fact: "7 days in a row",
            qualifier: "At least 10M tokens every day",
          },
          {
            fact: "30 days in a row",
            qualifier: "At least 10M tokens every day",
          },
          {
            fact: "365 days in a row",
            qualifier: "At least 10M tokens every day",
          },
        ],
      },
    },
    {
      id: "A16",
      grade: "silver",
      zh: {
        title: "月月都有你",
        detail: "阴晴圆缺不足为奇，可曾窥视月之暗面？",
        conditions: [
          {
            fact: "累计活跃 3 个月",
            qualifier: "每月至少有 10 天用量达到 1000 万 Token",
          },
          {
            fact: "累计活跃 12 个月",
            qualifier: "每月至少有 10 天用量达到 1000 万 Token",
          },
          {
            fact: "累计活跃 24 个月",
            qualifier: "每月至少有 10 天用量达到 1000 万 Token",
          },
        ],
      },
      en: {
        title: "Month After Month",
        detail: "The moon's phases are old news. Ever seen its dark side?",
        conditions: [
          {
            fact: "3 active months",
            qualifier: "At least 10 days per month with 10M tokens or more each day",
          },
          {
            fact: "12 active months",
            qualifier: "At least 10 days per month with 10M tokens or more each day",
          },
          {
            fact: "24 active months",
            qualifier: "At least 10 days per month with 10M tokens or more each day",
          },
        ],
      },
    },
    {
      id: "A18",
      grade: "silver",
      zh: {
        title: "在这住下了？",
        detail: "臻善尽美，不知疲倦",
        conditions: [
          {
            fact: "同一仓库累计活跃 30 天",
            qualifier: "每天至少 1 亿 Token",
          },
          {
            fact: "同一仓库累计活跃 90 天",
            qualifier: "每天至少 1 亿 Token",
          },
          {
            fact: "同一仓库累计活跃 180 天",
            qualifier: "每天至少 1 亿 Token",
          },
        ],
      },
      en: {
        title: "Moving In?",
        detail: "Tireless in the pursuit of perfection.",
        conditions: [
          {
            fact: "30 active days in one repository",
            qualifier: "At least 100M tokens on each of those days",
          },
          {
            fact: "90 active days in one repository",
            qualifier: "At least 100M tokens on each of those days",
          },
          {
            fact: "180 active days in one repository",
            qualifier: "At least 100M tokens on each of those days",
          },
        ],
      },
    },
    {
      id: "A19",
      grade: "silver",
      zh: {
        title: "有点上头",
        detail: "UTC-8 比 UTC+8 慢16小时，记好了",
        conditions: [
          {
            fact: "1 亿 Token",
            qualifier: "一天内的用量",
          },
          {
            fact: "10 亿 Token",
            qualifier: "一天内的用量",
          },
          {
            fact: "100 亿 Token",
            qualifier: "一天内的用量",
          },
        ],
      },
      en: {
        title: "Getting Carried Away",
        detail: "WHERE IS MY BANKED RESET!?",
        conditions: [
          {
            fact: "100M tokens",
            qualifier: "In a single day",
          },
          {
            fact: "1B tokens",
            qualifier: "In a single day",
          },
          {
            fact: "10B tokens",
            qualifier: "In a single day",
          },
        ],
      },
    },
    {
      id: "A23",
      grade: "silver",
      zh: {
        title: "注意力涣散...",
        detail: "善用 handoff 解决 99% 问题",
        conditions: [
          {
            fact: "5 亿 Token",
            qualifier: "一个会话的累计用量",
          },
          {
            fact: "10 亿 Token",
            qualifier: "一个会话的累计用量",
          },
          {
            fact: "50 亿 Token",
            qualifier: "一个会话的累计用量",
          },
        ],
      },
      en: {
        title: "Where Was I...?",
        detail: "(compaction: 400 Bad Request)",
        conditions: [
          {
            fact: "500M tokens",
            qualifier: "In a single session",
          },
          {
            fact: "1B tokens",
            qualifier: "In a single session",
          },
          {
            fact: "5B tokens",
            qualifier: "In a single session",
          },
        ],
      },
    },
    {
      id: "A24",
      grade: "silver",
      zh: {
        title: "多线开花",
        detail: "别把鸡蛋都放在一个篮子里",
        conditions: [
          {
            fact: "用过 5 个仓库",
            qualifier: "每个仓库累计至少 10 亿 Token",
          },
          {
            fact: "用过 10 个仓库",
            qualifier: "每个仓库累计至少 10 亿 Token",
          },
          {
            fact: "用过 30 个仓库",
            qualifier: "每个仓库累计至少 10 亿 Token",
          },
        ],
      },
      en: {
        title: "Branching Out",
        detail: "Don't put all your eggs in one basket.",
        conditions: [
          {
            fact: "5 repositories used",
            qualifier: "At least 1B tokens per repository",
          },
          {
            fact: "10 repositories used",
            qualifier: "At least 1B tokens per repository",
          },
          {
            fact: "30 repositories used",
            qualifier: "At least 1B tokens per repository",
          },
        ],
      },
    },
    {
      id: "A28",
      grade: "silver",
      zh: {
        title: "往来无白丁",
        detail: "“我们还行吧？” “那当然！” - 食人魔魔法师",
        conditions: [
          {
            fact: "一天用过 4 种模型",
            qualifier: "每种当天至少 1 亿 Token",
          },
          {
            fact: "一天用过 7 种模型",
            qualifier: "每种当天至少 1 亿 Token",
          },
          {
            fact: "一天用过 10 种模型",
            qualifier: "每种当天至少 1 亿 Token",
          },
        ],
      },
      en: {
        title: "In Good Company",
        detail: "“Damn. We're good.” - Ogre Magi",
        conditions: [
          {
            fact: "4 models in one day",
            qualifier: "At least 100M tokens per model that day",
          },
          {
            fact: "7 models in one day",
            qualifier: "At least 100M tokens per model that day",
          },
          {
            fact: "10 models in one day",
            qualifier: "At least 100M tokens per model that day",
          },
        ],
      },
    },
    {
      id: "A29",
      grade: "silver",
      zh: {
        title: "谈笑有鸿儒",
        detail: "“那是松鼠吗？” “得了吧你！” - 食人魔魔法师",
        conditions: [
          {
            fact: "一周用过 3 种 Harness",
            qualifier: "每种当周至少 10 亿 Token",
          },
          {
            fact: "一周用过 5 种 Harness",
            qualifier: "每种当周至少 10 亿 Token",
          },
          {
            fact: "一周用过 7 种 Harness",
            qualifier: "每种当周至少 10 亿 Token",
          },
        ],
      },
      en: {
        title: "A Meeting of Minds",
        detail: "“Is that a squirrel? Come on.” - Ogre Magi",
        conditions: [
          {
            fact: "3 harnesses in one week",
            qualifier: "At least 1B tokens per harness that week",
          },
          {
            fact: "5 harnesses in one week",
            qualifier: "At least 1B tokens per harness that week",
          },
          {
            fact: "7 harnesses in one week",
            qualifier: "At least 1B tokens per harness that week",
          },
        ],
      },
    },
    {
      id: "A30",
      grade: "silver",
      zh: {
        title: "老搭档",
        detail: "穿烂了的T恤最舒服",
        conditions: [
          {
            fact: "同一模型累计用了 7 天",
            qualifier: "每天至少 1 亿 Token",
          },
          {
            fact: "同一模型累计用了 15 天",
            qualifier: "每天至少 1 亿 Token",
          },
          {
            fact: "同一模型累计用了 45 天",
            qualifier: "每天至少 1 亿 Token",
          },
        ],
      },
      en: {
        title: "Old Reliable",
        detail: "Nothing beats a worn-out T-shirt.",
        conditions: [
          {
            fact: "7 days with one model",
            qualifier: "At least 100M tokens on each of those days",
          },
          {
            fact: "15 days with one model",
            qualifier: "At least 100M tokens on each of those days",
          },
          {
            fact: "45 days with one model",
            qualifier: "At least 100M tokens on each of those days",
          },
        ],
      },
    },
    {
      id: "A31",
      grade: "stone",
      zh: {
        title: "启程",
        detail: "开启一段美好的旅程，逐步发现创造一个世界有多美妙",
        conditions: [
          {
            fact: "首次产生 Token 用量",
          },
        ],
      },
      en: {
        title: "First Steps",
        detail: "Set off on a wonderful journey, and discover the joy of creating a world.",
        conditions: [
          {
            fact: "First token usage recorded",
          },
        ],
      },
    },
    {
      id: "A32",
      grade: "stone",
      zh: {
        title: "百亿纪念",
        detail: "有没有算过这能买几张钢化膜？",
        conditions: [
          {
            fact: "累计 100 亿 Token",
          },
        ],
      },
      en: {
        title: "10B Milestone",
        detail: "Ever worked out how many tempered glass screen protectors that could buy?",
        conditions: [
          {
            fact: "10B tokens in total",
          },
        ],
      },
    },
    {
      id: "A33",
      grade: "stone",
      zh: {
        title: "我觉得它说得不对",
        detail: "今儿个你俩就得在这儿给我掰扯清楚喽",
        conditions: [
          {
            fact: "同一会话用了 2 种模型",
            qualifier: "每种至少 1 亿 Token",
          },
        ],
      },
      en: {
        title: "I Beg to Differ",
        detail: "You two are going to settle this, right here, right now.",
        conditions: [
          {
            fact: "2 models in one session",
            qualifier: "At least 100M tokens per model in that session",
          },
        ],
      },
    },
    {
      id: "A36",
      grade: "stone",
      zh: {
        title: "旧友重逢",
        detail: "今夕复何夕，共此灯烛光",
        conditions: [
          {
            fact: "时隔至少 30 天重逢",
            qualifier: "再次使用同一模型，当天至少 1 亿 Token",
          },
        ],
      },
      en: {
        title: "Hello, Old Friend",
        detail: "Tonight, oh what a happy night!\nWe sit beneath the same candlelight.",
        conditions: [
          {
            fact: "Back after 30+ days",
            qualifier: "Used the same model again, with at least 100M tokens that day",
          },
        ],
      },
    },
    {
      id: "A38",
      grade: "stone",
      zh: {
        title: "明年也拜托啦",
        detail: "智械危机的命定幸存者",
        conditions: [
          {
            fact: "跨年两天都在用",
            qualifier: "12 月 31 日和次年 1 月 1 日各至少 100 万 Token",
          },
        ],
      },
      en: {
        title: "See You Next Year",
        detail: "Destined to survive the Omnic Crisis.",
        conditions: [
          {
            fact: "Active over New Year",
            qualifier: "At least 1M tokens on December 31 and again the following January 1",
          },
        ],
      },
    },
    {
      id: "A39",
      grade: "stone",
      zh: {
        title: "闰日来客",
        detail: "这样的机会可不多见",
        conditions: [
          {
            fact: "2 月 29 日也在用",
            qualifier: "当天至少 100 万 Token",
          },
        ],
      },
      en: {
        title: "Leap Day Visitor",
        detail: "You don't get a chance like this every year.",
        conditions: [
          {
            fact: "Active on February 29",
            qualifier: "At least 1M tokens that day",
          },
        ],
      },
    },
    {
      id: "A43",
      grade: "silver",
      zh: {
        title: "有图有真相",
        detail: "你要横的还是竖的？",
        conditions: [
          {
            fact: "1 份用量战报",
            qualifier: "复制或保存，每份的用量数据都不同",
          },
          {
            fact: "10 份用量战报",
            qualifier: "复制或保存，每份的用量数据都不同",
          },
          {
            fact: "50 份用量战报",
            qualifier: "复制或保存，每份的用量数据都不同",
          },
        ],
      },
      en: {
        title: "Pics or It Didn't Happen",
        detail: "Landscape or portrait?",
        conditions: [
          {
            fact: "1 usage card",
            qualifier: "Copied or saved, each with different usage data",
          },
          {
            fact: "10 usage cards",
            qualifier: "Copied or saved, each with different usage data",
          },
          {
            fact: "50 usage cards",
            qualifier: "Copied or saved, each with different usage data",
          },
        ],
      },
    },
    {
      id: "A44",
      grade: "stone",
      zh: {
        title: "我全都要！",
        detail: "Ciallo ～(∠・ω< )⌒★!",
        conditions: [
          {
            fact: "用过全部 8 款角色皮肤",
          },
        ],
      },
      en: {
        title: "I'll Take Them All!",
        detail: "Ciallo ～(∠・ω< )⌒★!",
        conditions: [
          {
            fact: "All 8 character skins used",
          },
        ],
      },
    },
    {
      id: "A46",
      grade: "stone",
      zh: {
        title: "青铜龙的惠赠",
        detail: "“失去的时光再也无法找回。哦，算了，我找到了。” - 克罗米",
        conditions: [
          {
            fact: "成功恢复历史备份",
          },
        ],
      },
      en: {
        title: "Gift of the Bronze Dragonflight",
        detail: "“Lost time is never found again. Oh, never mind, I found it.” - Chromie",
        conditions: [
          {
            fact: "Restored a history backup",
          },
        ],
      },
    },
    {
      id: "A53",
      grade: "silver",
      zh: {
        title: "你知道得太多了",
        detail: "“看这里。” - 黑衣人3",
        conditions: [
          {
            fact: "10 亿 Token",
            qualifier: "同一个模型的累计用量",
          },
          {
            fact: "50 亿 Token",
            qualifier: "同一个模型的累计用量",
          },
          {
            fact: "150 亿 Token",
            qualifier: "同一个模型的累计用量",
          },
        ],
      },
      en: {
        title: "You Know Too Much",
        detail: "“Look right here.” - Men in Black",
        conditions: [
          {
            fact: "1B tokens",
            qualifier: "Total usage with one model",
          },
          {
            fact: "5B tokens",
            qualifier: "Total usage with one model",
          },
          {
            fact: "15B tokens",
            qualifier: "Total usage with one model",
          },
        ],
      },
    },
    {
      id: "A54",
      grade: "silver",
      zh: {
        title: "只是懒得换Harness",
        detail: "“懒惰是济世的福音！” - 徐志摩",
        conditions: [
          {
            fact: "100 亿 Token",
            qualifier: "同一种 Harness 的累计用量",
          },
          {
            fact: "2000 亿 Token",
            qualifier: "同一种 Harness 的累计用量",
          },
          {
            fact: "1 万亿 Token",
            qualifier: "同一种 Harness 的累计用量",
          },
        ],
      },
      en: {
        title: "Too Lazy to Switch",
        detail: '"Progress is made by lazy men looking for easier ways to do things." - Lazarus Long',
        conditions: [
          {
            fact: "10B tokens",
            qualifier: "Total usage with one harness",
          },
          {
            fact: "200B tokens",
            qualifier: "Total usage with one harness",
          },
          {
            fact: "1T tokens",
            qualifier: "Total usage with one harness",
          },
        ],
      },
    },
    {
      id: "A55",
      grade: "silver",
      zh: {
        title: "深坑",
        detail: "如果这不是在自研一款浏览器内核，那么是时候停下了",
        conditions: [
          {
            fact: "10 亿 Token",
            qualifier: "同一个仓库的累计用量",
          },
          {
            fact: "500 亿 Token",
            qualifier: "同一个仓库的累计用量",
          },
          {
            fact: "1 万亿 Token",
            qualifier: "同一个仓库的累计用量",
          },
        ],
      },
      en: {
        title: "Down the Rabbit Hole",
        detail: "Unless you're building a browser engine from scratch, it's time to stop.",
        conditions: [
          {
            fact: "1B tokens",
            qualifier: "Total usage in one repository",
          },
          {
            fact: "50B tokens",
            qualifier: "Total usage in one repository",
          },
          {
            fact: "1T tokens",
            qualifier: "Total usage in one repository",
          },
        ],
      },
    },
    {
      id: "A56",
      grade: "silver",
      zh: {
        title: "十亿日常",
        detail: "端侧大模型，很厉害吗？",
        conditions: [
          {
            fact: "累计达标 5 天",
            qualifier: "这些天的单日用量均达到 10 亿 Token",
          },
          {
            fact: "累计达标 10 天",
            qualifier: "这些天的单日用量均达到 10 亿 Token",
          },
          {
            fact: "累计达标 30 天",
            qualifier: "这些天的单日用量均达到 10 亿 Token",
          },
        ],
      },
      en: {
        title: "A Billion a Day",
        detail: "On-device LLMs? Am I supposed to be impressed?",
        conditions: [
          {
            fact: "5 qualifying days in total",
            qualifier: "At least 1B tokens on each of those days",
          },
          {
            fact: "10 qualifying days in total",
            qualifier: "At least 1B tokens on each of those days",
          },
          {
            fact: "30 qualifying days in total",
            qualifier: "At least 1B tokens on each of those days",
          },
        ],
      },
    },
    {
      id: "A58",
      grade: "silver",
      zh: {
        title: "用量特别管够",
        detail: "“你根本不是土耳其大学生，你到底是谁？” - Google CEO",
        conditions: [
          {
            fact: "30 亿 Token",
            qualifier: "一个自然月内的用量",
          },
          {
            fact: "100 亿 Token",
            qualifier: "一个自然月内的用量",
          },
          {
            fact: "1000 亿 Token",
            qualifier: "一个自然月内的用量",
          },
        ],
      },
      en: {
        title: "Tokens for Days",
        detail: "“Senator, I'm Singaporean!”",
        conditions: [
          {
            fact: "3B tokens",
            qualifier: "In one calendar month",
          },
          {
            fact: "10B tokens",
            qualifier: "In one calendar month",
          },
          {
            fact: "100B tokens",
            qualifier: "In one calendar month",
          },
        ],
      },
    },
    {
      id: "A59",
      grade: "silver",
      zh: {
        title: "用量管够",
        detail: "专业用户，果然非同凡响",
        conditions: [
          {
            fact: "10 亿 Token",
            qualifier: "一个自然周内的用量",
          },
          {
            fact: "30 亿 Token",
            qualifier: "一个自然周内的用量",
          },
          {
            fact: "100 亿 Token",
            qualifier: "一个自然周内的用量",
          },
        ],
      },
      en: {
        title: "Tokens to Spare",
        detail: "Now that's what I call a Pro user.",
        conditions: [
          {
            fact: "1B tokens",
            qualifier: "In one calendar week",
          },
          {
            fact: "3B tokens",
            qualifier: "In one calendar week",
          },
          {
            fact: "10B tokens",
            qualifier: "In one calendar week",
          },
        ],
      },
    },
    {
      id: "A63",
      grade: "silver",
      zh: {
        title: "Alt + Tab",
        detail: "(请勿传播) Token 记录翻倍秘笈：Ctrl+W",
        conditions: [
          {
            fact: "一天用过 3 种 Harness",
            qualifier: "每种当天至少 1 亿 Token",
          },
          {
            fact: "一天用过 5 种 Harness",
            qualifier: "每种当天至少 1 亿 Token",
          },
          {
            fact: "一天用过 7 种 Harness",
            qualifier: "每种当天至少 1 亿 Token",
          },
        ],
      },
      en: {
        title: "Alt + Tab",
        detail: "(Keep this to yourself.) Cheat code for double tokens: Ctrl+W.",
        conditions: [
          {
            fact: "3 harnesses in one day",
            qualifier: "At least 100M tokens per harness that day",
          },
          {
            fact: "5 harnesses in one day",
            qualifier: "At least 100M tokens per harness that day",
          },
          {
            fact: "7 harnesses in one day",
            qualifier: "At least 100M tokens per harness that day",
          },
        ],
      },
    },
    {
      id: "A65",
      grade: "silver",
      zh: {
        title: "出勤率挺高啊",
        detail: "跟上班也没两样了",
        conditions: [
          {
            fact: "累计达标 3 个月",
            qualifier: "每月至少有 20 天用量达到 1 亿 Token",
          },
          {
            fact: "累计达标 6 个月",
            qualifier: "每月至少有 20 天用量达到 1 亿 Token",
          },
          {
            fact: "累计达标 12 个月",
            qualifier: "每月至少有 20 天用量达到 1 亿 Token",
          },
        ],
      },
      en: {
        title: "Quite the Regular",
        detail: "Might as well clock in at this point.",
        conditions: [
          {
            fact: "3 qualifying months",
            qualifier: "At least 20 days per month with 100M tokens or more each day",
          },
          {
            fact: "6 qualifying months",
            qualifier: "At least 20 days per month with 100M tokens or more each day",
          },
          {
            fact: "12 qualifying months",
            qualifier: "At least 20 days per month with 100M tokens or more each day",
          },
        ],
      },
    },
    {
      id: "A69",
      grade: "stone",
      zh: {
        title: "千亿纪念",
        detail: "有没有算过这能买几张 GTX 1050？",
        conditions: [
          {
            fact: "累计 1000 亿 Token",
          },
        ],
      },
      en: {
        title: "100B Milestone",
        detail: "Ever worked out how many GTX 1050 that could buy?",
        conditions: [
          {
            fact: "100B tokens in total",
          },
        ],
      },
    },
    {
      id: "A70",
      grade: "stone",
      zh: {
        title: "万亿纪念",
        detail: "有没有算过这能买几张 RTX 5070 Ti？",
        conditions: [
          {
            fact: "累计 1 万亿 Token",
          },
        ],
      },
      en: {
        title: "1T Milestone",
        detail: "Ever worked out how many RTX 5070 Ti that could buy?",
        conditions: [
          {
            fact: "1T tokens in total",
          },
        ],
      },
    },
    {
      id: "A71",
      grade: "stone",
      zh: {
        title: "十万亿纪念",
        detail: "有没有算过这能买几张 RTX PRO 6000？",
        conditions: [
          {
            fact: "累计 10 万亿 Token",
          },
        ],
      },
      en: {
        title: "10T Milestone",
        detail: "Ever worked out how many RTX PRO 6000 that could buy?",
        conditions: [
          {
            fact: "10T tokens in total",
          },
        ],
      },
    },
    {
      id: "A73",
      grade: "stone",
      zh: {
        title: "中满贯",
        detail: "不是小满贯",
        conditions: [
          {
            fact: "集齐全部铜级成就",
          },
        ],
      },
      en: {
        title: "Bronze Slam",
        detail: "Tall",
        conditions: [
          {
            fact: "Every bronze achievement earned",
          },
        ],
      },
    },
    {
      id: "A74",
      grade: "stone",
      zh: {
        title: "大满贯",
        detail: "真正的大满贯",
        conditions: [
          {
            fact: "集齐全部银级成就",
          },
        ],
      },
      en: {
        title: "Silver Slam",
        detail: "Grande",
        conditions: [
          {
            fact: "Every silver achievement earned",
          },
        ],
      },
    },
    {
      id: "A75",
      grade: "stone",
      zh: {
        title: "超大满贯",
        detail: "别这样罗老师，别这样",
        conditions: [
          {
            fact: "集齐全部金级成就",
          },
        ],
      },
      en: {
        title: "Gold Slam",
        detail: "Venti",
        conditions: [
          {
            fact: "Every gold achievement earned",
          },
        ],
      },
    },
    {
      id: "A76",
      grade: "stone",
      zh: {
        title: "千奇百怪的漫长旅行",
        detail: "紫色始祖幼龙的缰绳 (拾取后绑定)",
        conditions: [
          {
            fact: "集齐其余 11 项故事成就",
          },
        ],
      },
      en: {
        title: "What a Long, Strange Trip It's Been",
        detail: "Reins of the Violet Proto-Drake (Binds when picked up)",
        conditions: [
          {
            fact: "Earned all 11 other Stories achievements",
          },
        ],
      },
    },
  ],
  poses: {
    A01: "./art/poses/A01-silver.webp",
    A06: "./art/poses/A06-silver.webp",
    A07: "./art/poses/A07-silver.webp",
    A08: "./art/poses/A08-silver.webp",
    A09: "./art/poses/A09-silver.webp",
    A10: "./art/poses/A10-silver.webp",
    A11: "./art/poses/A11-silver.webp",
    A12: "./art/poses/A12-silver.webp",
    A13: "./art/poses/A13-silver.webp",
    A16: "./art/poses/A16-silver.webp",
    A18: "./art/poses/A18-silver.webp",
    A19: "./art/poses/A19-silver.webp",
    A23: "./art/poses/A23-silver.webp",
    A24: "./art/poses/A24-silver.webp",
    A28: "./art/poses/A28-silver.webp",
    A29: "./art/poses/A29-silver.webp",
    A30: "./art/poses/A30-silver.webp",
    A31: "./art/poses/A31-stone.webp",
    A33: "./art/poses/A33-stone.webp",
    A38: "./art/poses/A38-stone.webp",
    A39: "./art/poses/A39-stone.webp",
    A43: "./art/poses/A43-silver.webp",
    A44: "./art/poses/A44-stone.webp",
    A46: "./art/poses/A46-stone.webp",
    A53: "./art/poses/A53-silver.webp",
    A54: "./art/poses/A54-silver.webp",
    A55: "./art/poses/A55-silver.webp",
    A56: "./art/poses/A56-silver.webp",
    A58: "./art/poses/A58-silver.webp",
    A59: "./art/poses/A59-silver.webp",
    A63: "./art/poses/A63-silver.webp",
    A65: "./art/poses/A65-silver.webp",
    A69: "./art/poses/A69-stone.webp",
    A70: "./art/poses/A70-stone.webp",
    A71: "./art/poses/A71-stone.webp",
    A73: "./art/poses/A73-stone.webp",
    A74: "./art/poses/A74-stone.webp",
    A75: "./art/poses/A75-stone.webp",
    A76: "./art/poses/A76-stone.webp",
    A32: "./art/poses/A32-stone.png",
    A36: "./art/poses/A36-stone.png",
    A14: "./art/poses/A14-silver.png",
  },
  skins: {
    chatgpt: {
      name: "ChatGPT",
      light: {
        image: "../../../assets/skins/light/ChatGPT-side-lineart.webp",
        palette: {
          "--bg": "#F1EEFC",
          "--neo-surface": "#FAF9FF",
          "--control": "#FAF9FF",
          "--neo-edge": "#EBEAF0",
          "--line": "#EBEAF0",
          "--ink": "#15131B",
          "--muted": "#3A3742",
          "--chart-text": "#504E59",
          "--chart-line": "#37363d",
          "--control-hover": "#e4e3ea",
          "--blue": "#50578E",
          "--record": "#50578E",
          "--skin-active-accent": "#50578E",
          "--active-ink": "#ffffff",
          "--ceramic-top": "#fbfbff",
          "--ceramic-bottom": "#f5f3fd",
          "--ceramic-well": "#e5e3f0",
          "--ceramic-light": "rgba(254, 254, 255, 0.6)",
          "--ceramic-shade": "rgba(188, 186, 196, 0.54)",
          "--ceramic-rim": "rgba(254, 254, 255, 0.6)",
        },
      },
      dark: {
        image: "../../../assets/skins/dark/ChatGPT-side-dark-lineart.webp",
        palette: {
          "--bg": "#18161F",
          "--neo-surface": "#222127",
          "--control": "#222127",
          "--neo-edge": "#2B2B2F",
          "--line": "#2B2B2F",
          "--ink": "#EFEDFA",
          "--muted": "#B7B5C2",
          "--chart-text": "#B7B5C2",
          "--chart-line": "#d0ceda",
          "--control-hover": "#29282d",
          "--blue": "#A9B2F1",
          "--record": "#A9B2F1",
          "--skin-active-accent": "#A9B2F1",
          "--active-ink": "#10151a",
          "--ceramic-top": "#2a292e",
          "--ceramic-bottom": "#17161b",
          "--ceramic-well": "#1e1c23",
          "--ceramic-light": "rgba(53, 53, 56, 0.4)",
          "--ceramic-shade": "rgba(2, 2, 4, 0.72)",
          "--ceramic-rim": "rgba(53, 53, 56, 0.4)",
        },
      },
    },
    claude: {
      name: "Claude",
      light: {
        image: "../../../assets/skins/light/Claude-side-lineart.webp",
        palette: {
          "--bg": "#FDEDE2",
          "--neo-surface": "#FFF9F5",
          "--control": "#FFF9F5",
          "--neo-edge": "#F0EAE6",
          "--line": "#F0EAE6",
          "--ink": "#191310",
          "--muted": "#403732",
          "--chart-text": "#584D46",
          "--chart-line": "#3c3632",
          "--control-hover": "#ebe3de",
          "--blue": "#9A3D12",
          "--record": "#9A3D12",
          "--skin-active-accent": "#9A3D12",
          "--active-ink": "#ffffff",
          "--ceramic-top": "#fffbf8",
          "--ceramic-bottom": "#fef2eb",
          "--ceramic-well": "#f1e2d7",
          "--ceramic-light": "rgba(255, 254, 254, 0.6)",
          "--ceramic-shade": "rgba(197, 186, 178, 0.54)",
          "--ceramic-rim": "rgba(255, 254, 254, 0.6)",
        },
      },
      dark: {
        image: "../../../assets/skins/dark/Claude-side-dark-lineart.webp",
        palette: {
          "--bg": "#171514",
          "--neo-surface": "#21201F",
          "--control": "#21201F",
          "--neo-edge": "#2B2A29",
          "--line": "#2B2A29",
          "--ink": "#F9ECE4",
          "--muted": "#C1B4AC",
          "--chart-text": "#C1B4AC",
          "--chart-line": "#d9cdc6",
          "--control-hover": "#262524",
          "--blue": "#FF9971",
          "--record": "#FF9971",
          "--skin-active-accent": "#FF9971",
          "--active-ink": "#10151a",
          "--ceramic-top": "#262524",
          "--ceramic-bottom": "#181716",
          "--ceramic-well": "#1d1b1a",
          "--ceramic-light": "rgba(46, 45, 44, 0.4)",
          "--ceramic-shade": "rgba(7, 6, 6, 0.72)",
          "--ceramic-rim": "rgba(46, 45, 44, 0.4)",
        },
      },
    },
    glm: {
      name: "GLM",
      light: {
        image: "../../../assets/skins/light/GLM-side-lineart.webp",
        palette: {
          "--bg": "#E6E8EC",
          "--neo-surface": "#F1F2F4",
          "--control": "#F1F2F4",
          "--neo-edge": "#E2E3E4",
          "--line": "#E2E3E4",
          "--ink": "#0F1013",
          "--muted": "#343536",
          "--chart-text": "#4E4F53",
          "--chart-line": "#313235",
          "--control-hover": "#dbdcdf",
          "--blue": "#224BC1",
          "--record": "#224BC1",
          "--skin-active-accent": "#224BC1",
          "--active-ink": "#ffffff",
          "--ceramic-top": "#f4f5f6",
          "--ceramic-bottom": "#ebedf0",
          "--ceramic-well": "#dbdde0",
          "--ceramic-light": "rgba(250, 250, 251, 0.6)",
          "--ceramic-shade": "rgba(179, 180, 183, 0.54)",
          "--ceramic-rim": "rgba(250, 250, 251, 0.6)",
        },
      },
      dark: {
        image: "../../../assets/skins/dark/GLM-side-dark-lineart.webp",
        palette: {
          "--bg": "#151619",
          "--neo-surface": "#202022",
          "--control": "#202022",
          "--neo-edge": "#2A2A2B",
          "--line": "#2A2A2B",
          "--ink": "#EDEEF3",
          "--muted": "#B5B7BB",
          "--chart-text": "#B5B7BB",
          "--chart-line": "#cecfd4",
          "--control-hover": "#272729",
          "--blue": "#94B6FF",
          "--record": "#94B6FF",
          "--skin-active-accent": "#94B6FF",
          "--active-ink": "#10151a",
          "--ceramic-top": "#28282a",
          "--ceramic-bottom": "#151617",
          "--ceramic-well": "#1b1c1e",
          "--ceramic-light": "rgba(52, 52, 53, 0.4)",
          "--ceramic-shade": "rgba(1, 2, 2, 0.72)",
          "--ceramic-rim": "rgba(52, 52, 53, 0.4)",
        },
      },
    },
    gemini: {
      name: "Gemini",
      light: {
        image: "../../../assets/skins/light/Gemini-side-lineart.webp",
        palette: {
          "--bg": "#FFF3FA",
          "--neo-surface": "#FFFEFF",
          "--control": "#FFFEFF",
          "--neo-edge": "#F3EEF1",
          "--line": "#F3EEF1",
          "--ink": "#1C1519",
          "--muted": "#433940",
          "--chart-text": "#574C53",
          "--chart-line": "#3e383c",
          "--control-hover": "#ece8eb",
          "--blue": "#82459A",
          "--record": "#82459A",
          "--skin-active-accent": "#82459A",
          "--active-ink": "#ffffff",
          "--ceramic-top": "#fffeff",
          "--ceramic-bottom": "#fff8fc",
          "--ceramic-well": "#f3e8ee",
          "--ceramic-light": "rgba(255, 254, 255, 0.6)",
          "--ceramic-shade": "rgba(201, 191, 197, 0.54)",
          "--ceramic-rim": "rgba(255, 254, 255, 0.6)",
        },
      },
      dark: {
        image: "../../../assets/skins/dark/Gemini-side-dark-lineart.webp",
        palette: {
          "--bg": "#1F161C",
          "--neo-surface": "#282226",
          "--control": "#282226",
          "--neo-edge": "#312C2F",
          "--line": "#312C2F",
          "--ink": "#F8EAF2",
          "--muted": "#BFB3BB",
          "--chart-text": "#BFB3BB",
          "--chart-line": "#d9ccd3",
          "--control-hover": "#2e292d",
          "--blue": "#DB99F5",
          "--record": "#DB99F5",
          "--skin-active-accent": "#DB99F5",
          "--active-ink": "#10151a",
          "--ceramic-top": "#2f2a2e",
          "--ceramic-bottom": "#1c171a",
          "--ceramic-well": "#241d22",
          "--ceramic-light": "rgba(58, 55, 57, 0.4)",
          "--ceramic-shade": "rgba(5, 2, 4, 0.72)",
          "--ceramic-rim": "rgba(58, 55, 57, 0.4)",
        },
      },
    },
    deepseek: {
      name: "DeepSeek",
      light: {
        image: "../../../assets/skins/light/DeepSeek-side-lineart.webp",
        palette: {
          "--bg": "#E2ECFC",
          "--neo-surface": "#F0F6FF",
          "--control": "#F0F6FF",
          "--neo-edge": "#E2E6ED",
          "--line": "#E2E6ED",
          "--ink": "#121212",
          "--muted": "#313740",
          "--chart-text": "#4A505A",
          "--chart-line": "#333436",
          "--control-hover": "#dae0ea",
          "--blue": "#3252AD",
          "--record": "#3252AD",
          "--skin-active-accent": "#3252AD",
          "--active-ink": "#ffffff",
          "--ceramic-top": "#f4f8ff",
          "--ceramic-bottom": "#e8f1fd",
          "--ceramic-well": "#d7e1f0",
          "--ceramic-light": "rgba(252, 253, 255, 0.6)",
          "--ceramic-shade": "rgba(176, 184, 196, 0.54)",
          "--ceramic-rim": "rgba(252, 253, 255, 0.6)",
        },
      },
      dark: {
        image: "../../../assets/skins/dark/DeepSeek-side-dark-lineart.webp",
        palette: {
          "--bg": "#141B26",
          "--neo-surface": "#21252D",
          "--control": "#21252D",
          "--neo-edge": "#2C2F34",
          "--line": "#2C2F34",
          "--ink": "#E8EFFB",
          "--muted": "#B0B8C3",
          "--chart-text": "#B0B8C3",
          "--chart-line": "#cad1dc",
          "--control-hover": "#292c33",
          "--blue": "#96B6FF",
          "--record": "#96B6FF",
          "--skin-active-accent": "#96B6FF",
          "--active-ink": "#10151a",
          "--ceramic-top": "#2a2d33",
          "--ceramic-bottom": "#161920",
          "--ceramic-well": "#1b212a",
          "--ceramic-light": "rgba(55, 57, 61, 0.4)",
          "--ceramic-shade": "rgba(1, 3, 8, 0.72)",
          "--ceramic-rim": "rgba(55, 57, 61, 0.4)",
        },
      },
    },
    kimi: {
      name: "Kimi",
      light: {
        image: "../../../assets/skins/light/Kimi-side-lineart.webp",
        palette: {
          "--bg": "#E6F7F9",
          "--neo-surface": "#FAFEFF",
          "--control": "#FAFEFF",
          "--neo-edge": "#E9F0F1",
          "--line": "#E9F0F1",
          "--ink": "#0F1718",
          "--muted": "#3A3A3A",
          "--chart-text": "#445354",
          "--chart-line": "#323a3b",
          "--control-hover": "#e2e9ea",
          "--blue": "#2E656C",
          "--record": "#2E656C",
          "--skin-active-accent": "#2E656C",
          "--active-ink": "#ffffff",
          "--ceramic-top": "#fbfeff",
          "--ceramic-bottom": "#effafc",
          "--ceramic-well": "#dbebed",
          "--ceramic-light": "rgba(253, 255, 255, 0.6)",
          "--ceramic-shade": "rgba(182, 194, 195, 0.54)",
          "--ceramic-rim": "rgba(253, 255, 255, 0.6)",
        },
      },
      dark: {
        image: "../../../assets/skins/dark/Kimi-side-dark-lineart.webp",
        palette: {
          "--bg": "#121516",
          "--neo-surface": "#1D2021",
          "--control": "#1D2021",
          "--neo-edge": "#272A2B",
          "--line": "#272A2B",
          "--ink": "#E2F2F4",
          "--muted": "#ABBBBC",
          "--chart-text": "#ABBBBC",
          "--chart-line": "#c4d3d4",
          "--control-hover": "#232627",
          "--blue": "#43CCDE",
          "--record": "#43CCDE",
          "--skin-active-accent": "#43CCDE",
          "--active-ink": "#10151a",
          "--ceramic-top": "#232627",
          "--ceramic-bottom": "#151718",
          "--ceramic-well": "#181b1c",
          "--ceramic-light": "rgba(45, 48, 49, 0.4)",
          "--ceramic-shade": "rgba(5, 6, 7, 0.72)",
          "--ceramic-rim": "rgba(45, 48, 49, 0.4)",
        },
      },
    },
    qwen: {
      name: "Qwen",
      light: {
        image: "../../../assets/skins/light/Qwen-side-lineart.webp",
        palette: {
          "--bg": "#F0FAF3",
          "--neo-surface": "#FDFFFD",
          "--control": "#FDFFFD",
          "--neo-edge": "#EDF0EE",
          "--line": "#EDF0EE",
          "--ink": "#171717",
          "--muted": "#3C3C3C",
          "--chart-text": "#4A524C",
          "--chart-line": "#3a3a3a",
          "--control-hover": "#e7eae8",
          "--blue": "#3F6659",
          "--record": "#3F6659",
          "--skin-active-accent": "#3F6659",
          "--active-ink": "#ffffff",
          "--ceramic-top": "#fdfffd",
          "--ceramic-bottom": "#f6fcf8",
          "--ceramic-well": "#e5eee8",
          "--ceramic-light": "rgba(253, 255, 253, 0.6)",
          "--ceramic-shade": "rgba(190, 196, 192, 0.54)",
          "--ceramic-rim": "rgba(253, 255, 253, 0.6)",
        },
      },
      dark: {
        image: "../../../assets/skins/dark/Qwen-side-dark-lineart.webp",
        palette: {
          "--bg": "#0D100E",
          "--neo-surface": "#272B29",
          "--control": "#272B29",
          "--neo-edge": "#3D4340",
          "--line": "#3D4340",
          "--ink": "#E8F2EB",
          "--muted": "#C4CEC7",
          "--chart-text": "#C4CEC7",
          "--chart-line": "#cbd4ce",
          "--control-hover": "#323634",
          "--blue": "#6CCDAE",
          "--record": "#6CCDAE",
          "--skin-active-accent": "#6CCDAE",
          "--active-ink": "#10151a",
          "--ceramic-top": "#333835",
          "--ceramic-bottom": "#1a1d1c",
          "--ceramic-well": "#1b1f1d",
          "--ceramic-light": "rgba(69, 75, 72, 0.4)",
          "--ceramic-shade": "rgba(2, 4, 3, 0.72)",
          "--ceramic-rim": "rgba(69, 75, 72, 0.4)",
        },
      },
    },
    grok: {
      name: "Grok",
      light: {
        image: "../../../assets/skins/light/Grok-side-lineart.webp",
        palette: {
          "--bg": "#F2EADD",
          "--neo-surface": "#F9F4EC",
          "--control": "#F9F4EC",
          "--neo-edge": "#E9E6E0",
          "--line": "#E9E6E0",
          "--ink": "#171109",
          "--muted": "#383634",
          "--chart-text": "#554F45",
          "--chart-line": "#39332b",
          "--control-hover": "#e4dfd6",
          "--blue": "#5C5942",
          "--record": "#5C5942",
          "--skin-active-accent": "#5C5942",
          "--active-ink": "#ffffff",
          "--ceramic-top": "#fbf7f1",
          "--ceramic-bottom": "#f5efe4",
          "--ceramic-well": "#e6dfd2",
          "--ceramic-light": "rgba(255, 253, 250, 0.6)",
          "--ceramic-shade": "rgba(188, 183, 173, 0.54)",
          "--ceramic-rim": "rgba(255, 253, 250, 0.6)",
        },
      },
      dark: {
        image: "../../../assets/skins/dark/Grok-side-dark-lineart.webp",
        palette: {
          "--bg": "#111110",
          "--neo-surface": "#191918",
          "--control": "#191918",
          "--neo-edge": "#242423",
          "--line": "#242423",
          "--ink": "#F5EEE2",
          "--muted": "#BDB6AB",
          "--chart-text": "#BDB6AB",
          "--chart-line": "#d4cec4",
          "--control-hover": "#1e1e1d",
          "--blue": "#CCB93E",
          "--record": "#CCB93E",
          "--skin-active-accent": "#CCB93E",
          "--active-ink": "#10151a",
          "--ceramic-top": "#1f1f1e",
          "--ceramic-bottom": "#121211",
          "--ceramic-well": "#151514",
          "--ceramic-light": "rgba(39, 39, 38, 0.4)",
          "--ceramic-shade": "rgba(4, 4, 3, 0.72)",
          "--ceramic-rim": "rgba(39, 39, 38, 0.4)",
        },
      },
    },
  },
};

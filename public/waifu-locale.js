import { localizeText, registerLocaleExtension } from "./locale.js";
const englishText = (value) => localizeText(value, "en-US");
const ENGLISH = {
  "正在更新价格…": "Updating prices…",
  切换主题: "Switch Theme",
  分享图片: "Share image",
  辅助指标: "Metrics",
  图形: "Chart",
  版式: "Layout",
  图片比例: "Image aspect ratio",
  图片方向: "Orientation",
  竖版: "Portrait",
  横版: "Landscape",
  "Token 构成": "Token composition",
  显示费用: "Show cost",
  复制图片: "Copy image",
  保存图片: "Save image",
  查看原图: "View full image",
  图片内容: "Image content",
  第一个辅助指标: "First metric",
  第二个辅助指标: "Second metric",
  图片原图: "Full image",
  查看方式: "View",
  选择界面风格: "Choose Waifu",
  界面风格: "Waifu",
  显示角色: "Show characters",
  角色透明度: "Character opacity",
  简洁模式: "Simple mode",
  无皮肤: "No skin",
  不使用任何皮肤: "No skin of any kind",
  浅色: "Light",
  深色: "Dark",
  配色待定: "Colours pending",
  "当前深色主题，点击切换到浅色主题": "Dark theme. Switch to light theme",
  "当前浅色主题，点击切换到深色主题": "Light theme. Switch to dark theme",
  "API 费用估算": "Estimated API Cost",
  总花销: "Estimated Cost",
  估算花销: "Estimated Cost",
  费用: "Cost",
  费用估算: "Estimated Cost",
  按花销: "By Cost",
  费用估算说明: "About Cost Estimates",
  计价详情: "Pricing details",
  计价标准: "Pricing Rates",
  "勾选要统计的来源，取消勾选的来源不计入用量、费用和时间线，修改立即生效。":
    "Choose which sources to include. Changes to usage, cost estimates, and the timeline take effect immediately.",
  更新计价标准: "Update Pricing Rates",
  恢复自动汇率: "Restore automatic rate",
  "单价单位为对应模型的标价货币（USD 美元 / CNY 人民币）每 100 万 tokens。点击模型名编辑费率（含官方单独声明的快速模式价）；汇率只用于混合币种的排序与图表比例，不改变各币种金额。保存后按当天日期记为核对日期并重算历史估算。":
    "Rates are quoted per million tokens in each model's billing currency (USD or CNY). Select a model to edit its rates, including published fast tier rates. The exchange rate affects only sorting and chart proportions when currencies are mixed. Saving records today's review date and recalculates historical estimates.",
  "1 美元 =": "1 USD =",
  计价: "Currency",
  计价币种: "Display currency",
  美元: "USD",
  人民币: "CNY",
  阿里巴巴: "Alibaba",
  深度求索: "DeepSeek",
  稀宇科技: "MiniMax",
  月之暗面: "Moonshot AI",
  智谱: "Z.ai",
  小米: "Xiaomi",
  阶跃星辰: "StepFun",
  腾讯: "Tencent",
  百度: "Baidu",
  美团: "Meituan",
  保存并重算: "Save And Recalculate",
  模型计价: "Model Pricing",
  应用: "Apply",
  "近期使用时间尚未可用，暂显示已观测模型；重启本地服务后按近一个月筛选。":
    "Recent usage times are unavailable; showing observed models. Restart the local service to filter by the past month.",
  "费用估算暂不可用。": "Cost estimates are temporarily unavailable.",
  当前价格基准: "Current Pricing Baseline",
  "OpenAI 价格表": "OpenAI Pricing",
  "Anthropic 定价": "Anthropic Pricing",
  "StepFun 定价": "StepFun Pricing",
  "MiMo 定价": "MiMo Pricing",
  "DeepSeek 定价": "DeepSeek Pricing",
  "Kimi 定价": "Kimi Pricing",
  "GLM 定价": "GLM Pricing",
  价格来源: "Pricing Source",
  默认价格来源: "Default Pricing Source",
  按当前价目表估算: "Estimated using current rates",
  "金额按已知明细及最低费率情景折算 API 等价费用，不代表实际账单，也不含工具调用等非 token 费用。":
    "API-equivalent costs use available token details, with the lowest applicable rates used where details are missing. They are not actual bills and exclude tool calls and other non-token costs.",
  估算限制: "Estimate Limitations",
  "缓存读取与写入按各自官方费率计入总额。":
    "Cache-hit input and cache writes are charged at their respective published rates.",
  "更新计价标准后，所有已索引的历史用量会按新单价重算。":
    "Updating pricing rates recalculates estimates for all indexed usage.",
  "支持自动更新匹配的模型价格与美元兑人民币汇率；点击模型名或汇率可手动调整。":
    "Matching model prices and the USD/CNY exchange rate update automatically. Edit a model or the rate to override them.",
  "单价单位为对应模型的标价货币（USD 美元 / CNY 人民币）每 100 万 tokens。支持自动更新匹配的模型价格与美元兑人民币汇率；点击模型名或汇率可手动调整。保存后按当天日期重算历史估算。":
    "Prices are per million tokens in each model's listed currency (USD or CNY). Matching model prices and the USD/CNY rate update automatically; you can edit either manually. Saving recalculates historical estimates using today's date.",
  "正在读取更新状态…": "Loading update status…",
  立即更新: "Update now",
  "更新完成；未保存的编辑已重置。": "Update complete. Unsaved edits were reset.",
  没有可计价的费用记录: "No priced usage records",
  无可计价费用: "No priceable usage",
  估算金额: "Estimated Amount",
  "已计价 tokens": "Priced Tokens",
  "未计价 tokens": "Unpriced Tokens",
  未计价: "Unpriced",
  "服务等级未知，金额按 Standard 情景估算": "Service tier unknown; estimated at Standard rates",
  "请求上下文未知，按可用的较低上下文费率估算":
    "Request context unknown; estimated at the lower applicable context rate",
  "缓存写入明细未知，相关未知部分按最低费率估算":
    "Cache-write details unknown; the affected portion uses the lowest applicable rate",
  快速模式价: "Fast Mode Rates",
  短上下文: "Short Context",
  短上下文·长输出: "Short Context · Long Output",
  长上下文: "Long Context",
  标准模式: "Standard Mode",
  快速模式: "Fast Mode",
  快速·短上下文: "Fast · Short Context",
  快速·短上下文·长输出: "Fast · Short Context · Long Output",
  快速·长上下文: "Fast · Long Context",
  点击编辑该模型费率: "Edit this model's rates",
  没有匹配的模型: "No matching models",
  暂无模型: "No models available",
  暂无已用到的模型: "No used models found",
  "正在保存并重算…": "Saving and recalculating…",
};
const PATTERNS = [
  [5, [/^价格基准 (.+)$/, (_, date) => `Pricing baseline ${date}`]],
  [
    6,
    [
      /^按当前价目表估算 · (.+) · (.+)$/,
      (_, baseline, sources) => `Estimated using current rates · ${englishText(baseline)} · ${englishText(sources)}`,
    ],
  ],
  [
    7,
    [
      /^(.+) 条记录的服务等级未知，按 Standard 情景估算$/,
      (_, n) => `${n} records have an unknown service tier; estimated at Standard rates`,
    ],
  ],
  [
    8,
    [
      /^(.+) 条记录无法可靠对应单次请求输入，按可用的较低上下文费率估算$/,
      (_, n) => `${n} records lack reliable per-request input details; estimated at the lower applicable context rate`,
    ],
  ],
  [
    9,
    [
      /^(.+) 个输入 tokens 缺少缓存写入明细，相关未知部分按最低费率估算$/,
      (_, n) =>
        `Cache-write details are missing for ${n} input tokens; the affected portion uses the lowest applicable rate`,
    ],
  ],
  [
    10,
    [
      /^(.+) \/ (.+) tokens 使用最低费率估算$/,
      (_, n, total) => `${n} of ${total} tokens use the lowest applicable rate`,
    ],
  ],
  [
    11,
    [
      /^模型 (.+) 缺少专用单价，按价目表最低费率估算$/,
      (_, names) => `No model-specific rate for ${names.replaceAll("、", ", ")}; estimated at the lowest listed rate`,
    ],
  ],
  [12, [/^仍有 (.+) tokens 无法估算$/, (_, n) => `${n} tokens remain unpriced`]],
  [13, [/^仍无法计价的模型：(.+)$/, (_, names) => `Models still unpriced: ${names.replaceAll("、", ", ")}`]],
  [16, [/^(.+)，费用估算 (.+)$/, (_, name, amount) => `${name}, estimated cost ${amount}`]],
  [
    29,
    [
      /^(.+)，费用估算 (.+?)(?:，未计价 (.+) tokens)?$/,
      (_, interval, cost, unpriced) =>
        `${englishText(interval)}. Estimated cost ${cost}${unpriced ? `; ${unpriced} unpriced tokens` : ""}`,
    ],
  ],
  [30, [/^未计价 (.+) tokens$/, (_, n) => `${n} unpriced tokens`]],
  [31, [/^其中 (.+) tokens 按最低费率估算$/, (_, n) => `${n} tokens use the lowest applicable rate`]],
  [
    32,
    [
      /^时间分布，按模型堆叠 API 等价费用估算，(美元|人民币)为纵轴单位(.*)；每个时间槽可查看完整日期和模型费用$/,
      (_, currency, range) =>
        `Usage over time, with estimated API-equivalent costs stacked by model in ${currency === "人民币" ? "CNY" : "USD"}${englishText(range)}. Inspect each interval for dates and model costs`,
    ],
  ],
  [
    40,
    [
      /^单次输入超过 (.+) tokens 按长上下文价$/,
      (_, n) => `Long-context rates apply above ${n} input tokens per request`,
    ],
  ],
  [41, [/^输出达到 (.+) tokens 起按长输出价$/, (_, n) => `Long-output rates apply at ${n} output tokens or more`]],
  [
    42,
    [
      /^谷时按 (.+) 折计（北京时间工作日 9:00-12:00、14:00-18:00 为高峰，节假日未建模按高峰计）$/,
      (_, discount) =>
        `Off-peak rates are ${Number(discount) * 10}% of peak rates (Beijing time, weekdays 09:00–12:00 and 14:00–18:00; holidays are treated as peak)`,
    ],
  ],
  [43, [/^(.+)（入\/缓\/出）$/, (_, rates) => `${rates} (Cache Miss/Cache Hit/Output)`]],
  [44, [/^上下文 (.+) 分档$/, (_, n) => `Context tier at ${n}`]],
  [45, [/^输出 (.+) 分档$/, (_, n) => `Output tier at ${n}`]],
  [46, [/^谷时 (.+) 折$/, (_, discount) => `Off-peak ${Number(discount) * 10}%`]],
  [47, [/^请填写大于 0 的美元兑人民币汇率。$/, () => "Enter a USD-to-CNY exchange rate greater than zero."]],
  [48, [/^读取计价标准失败：(.+)$/, (_, error) => `Could not load pricing rates: ${englishText(error)}`]],
];
registerLocaleExtension(
  ENGLISH,
  PATTERNS,
  {
    INVALID_PRICING: "Check the pricing rates and exchange rate, then try again.",
  },
  [".pricing-model-name"],
);

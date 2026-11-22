function lab(name, mark, monochrome = false) {
  const logo = new URL(`./logos/${mark}.svg`, import.meta.url).href;
  const darkLogo = monochrome ? new URL(`./logos/${mark}-dark.svg`, import.meta.url).href : logo;
  return { name, logo, darkLogo };
}

export const LABS = {
  chatgpt: lab("OpenAI", "openai", true),
  claude: lab("Anthropic", "anthropic", true),
  glm: lab("Z.ai · 智谱", "zai", true),
  gemini: lab("Google DeepMind", "deepmind"),
  deepseek: lab("DeepSeek · 深度求索", "deepseek"),
  kimi: lab("Moonshot AI · 月之暗面", "moonshot", true),
  qwen: lab("Alibaba · 通义千问", "qwen"),
  grok: lab("xAI", "xai", true),
  muse: lab("Meta Superintelligence Labs", "meta"),
  mimo: lab("Xiaomi MiMo · 小米", "mimo", true),
};

export function logoPlacement(anchor, index, width, height, aspect) {
  const leftSide = index === 0;
  const gutter = anchor.gutterWidth;
  const size = Math.min(gutter * 0.68, anchor.height * (leftSide ? 0.29 : 0.23));
  const logoWidth = size * Math.min(1, aspect);
  const logoHeight = size / Math.max(1, aspect);
  const edge = logoWidth / 2 + 5;
  const from = leftSide ? edge : width - gutter + edge;
  const to = leftSide ? gutter - edge : width - edge;
  const x = Math.min(to, Math.max(from, anchor.x + (leftSide ? -1 : 1) * anchor.height * 0.025));
  const y = Math.min(height - logoHeight / 2 - 8, anchor.height * 1.06);
  return { x, y, width: logoWidth, height: logoHeight };
}

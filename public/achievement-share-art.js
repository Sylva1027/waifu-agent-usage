// The approved share artwork belongs to Waifu. The release builder follows these asset URLs.
const artwork = {
  chatgpt: {
    light: {
      background: "/assets/achievement-share/chatgpt/background-light.webp",
      figure: "/assets/achievement-share/chatgpt/relief-light.webp",
    },
    dark: {
      background: "/assets/achievement-share/chatgpt/background-dark.webp",
      figure: "/assets/achievement-share/chatgpt/relief-dark.webp",
    },
  },
  claude: {
    light: {
      background: "/assets/achievement-share/claude/background-light.png",
      figure: "/assets/achievement-share/claude/relief-light.webp",
    },
    dark: {
      background: "/assets/achievement-share/claude/background-dark.png",
      figure: "/assets/achievement-share/claude/relief-dark.webp",
    },
  },
  deepseek: {
    light: {
      background: "/assets/achievement-share/deepseek/background-light.webp",
      figure: "/assets/achievement-share/deepseek/relief-light.webp",
    },
    dark: {
      background: "/assets/achievement-share/deepseek/background-dark.webp",
      figure: "/assets/achievement-share/deepseek/relief-dark.webp",
    },
  },
  gemini: {
    light: {
      background: "/assets/achievement-share/gemini/background-light.webp",
      figure: "/assets/achievement-share/gemini/relief-light.webp",
    },
    dark: {
      background: "/assets/achievement-share/gemini/background-dark.webp",
      figure: "/assets/achievement-share/gemini/relief-dark.webp",
    },
  },
  glm: {
    light: {
      background: "/assets/achievement-share/glm/background-light.webp",
      figure: "/assets/achievement-share/glm/relief-light.webp",
    },
    dark: {
      background: "/assets/achievement-share/glm/background-dark.webp",
      figure: "/assets/achievement-share/glm/relief-dark.webp",
    },
  },
  grok: {
    light: {
      background: "/assets/achievement-share/grok/background-light.webp",
      figure: "/assets/achievement-share/grok/relief-light.webp",
    },
    dark: {
      background: "/assets/achievement-share/grok/background-dark.webp",
      figure: "/assets/achievement-share/grok/relief-dark.webp",
    },
  },
  kimi: {
    light: {
      background: "/assets/achievement-share/kimi/background-light.webp",
      figure: "/assets/achievement-share/kimi/relief-light.webp",
    },
    dark: {
      background: "/assets/achievement-share/kimi/background-dark.webp",
      figure: "/assets/achievement-share/kimi/relief-dark.webp",
    },
  },
  qwen: {
    light: {
      background: "/assets/achievement-share/qwen/background-light.webp",
      figure: "/assets/achievement-share/qwen/relief-light.webp",
    },
    dark: {
      background: "/assets/achievement-share/qwen/background-dark.webp",
      figure: "/assets/achievement-share/qwen/relief-dark.webp",
    },
  },
};

export function achievementShareArt(skinId, mode) {
  if (!Object.hasOwn(artwork, skinId) || (mode !== "light" && mode !== "dark")) return null;
  return artwork[skinId][mode];
}

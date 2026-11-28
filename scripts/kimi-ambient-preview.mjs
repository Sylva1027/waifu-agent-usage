import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { DEFAULT_SKIN_PREFERENCE, SKIN_PREFERENCE_KEY } from "../public/skins.js";
import { createUsageServer } from "../src/server.js";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

const previewDirectory = "/dev/waifu-visuals/kimi-ambient";
const kimiPreference = JSON.stringify({ ...DEFAULT_SKIN_PREFERENCE, skinId: "kimi" });

function previewHtml(html) {
  return html
    .replace('data-edition="waifu"', 'data-edition="waifu" data-skin-ambient="off"')
    .replace("<head>", `<head>
    <script>
      try {
        const key = ${JSON.stringify(SKIN_PREFERENCE_KEY)};
        const mode = new URLSearchParams(location.search).get("theme");
        if (mode === "light" || mode === "dark") {
          localStorage.setItem("codexUsageTheme", mode);
          const prefs=JSON.parse(localStorage.getItem(key) || ${JSON.stringify(kimiPreference)});
          localStorage.setItem(key, JSON.stringify({...prefs,skinId:"kimi"}));
        } else if (localStorage.getItem(key) === null) localStorage.setItem(key, ${JSON.stringify(kimiPreference)});
      } catch {}
    </script>`)
    .replace("</head>", `<link rel="stylesheet" href="${previewDirectory}/preview.css">
    <script type="module">
      import { state } from "/app-state.js";
      import { nextPresetState } from "/dashboard-view-utils.js";
      Object.assign(state, nextPresetState(state, "all"));
    </script>
  </head>`)
    .replace('<div id="skinCharacters"', `<div id="kimi-ambient" aria-hidden="true"></div><script type="module" src="${previewDirectory}/preview.js"></script><div id="skinCharacters"`);
}

export async function startKimiAmbientPreview(port = 4185) {
  const fixture = await createPaletteFixture();
  const server = createUsageServer(createPaletteServerOptions(fixture));
  // Transform only a successful dashboard response, after the normal request checks have run.
  server.prependListener("request", (request, response) => {
    const pathname = request.url.split("?", 1)[0];
    if (request.method !== "GET" || pathname !== "/") return;
    const end = response.end;
    response.end = function (body, ...args) {
      if (response.statusCode === 200 && Buffer.isBuffer(body)) body = previewHtml(body.toString("utf8"));
      return end.call(this, body, ...args);
    };
  });

  const close = async () => {
    try {
      await server.close();
    } finally {
      await fixture.close();
    }
  };
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    return { url: `http://127.0.0.1:${server.address().port}/`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startKimiAmbientPreview();
  console.log(`Kimi ambient dashboard: ${preview.url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, preview.close);
}

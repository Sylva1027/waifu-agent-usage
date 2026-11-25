// Filled from Nordify's top-edge tile by the development build.
declare const __FRAME_EDGE_PNG__: string;
declare const __FRAME_EDGE_SCALE__: number;

type FrameGlass = {
  setFrame(frame: Element | null): void;
  setOptics(press: number, velocity: number): void;
  destroy(): void;
};
const mounted = new WeakMap<Document, { root: HTMLElement; material: FrameGlass }>();

function filterMarkup(id: string, active: boolean) {
  // The source PNG stores vertical displacement in grey. A neutral red channel leaves x unchanged.
  return `<filter id="${id}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feImage href="${__FRAME_EDGE_PNG__}" preserveAspectRatio="none" result="profile"/>
    <feColorMatrix in="profile" values="0 0 0 0 .5  1 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="normal"/>
    <feDisplacementMap in="SourceGraphic" in2="normal" xChannelSelector="R" yChannelSelector="G" scale="${__FRAME_EDGE_SCALE__}" result="bent"/>
    ${active ? '<feComposite in="bent" in2="profile" operator="arithmetic" k2="1" k3="0" k4="0"/>' : ""}
  </filter>`;
}

export function mountFrameGlass(root: HTMLElement): FrameGlass {
  const doc = root.ownerDocument;
  const previous = mounted.get(doc);
  if (previous?.root === root) return previous.material;
  previous?.material.destroy();

  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  svg.innerHTML = `<defs>${filterMarkup("mg-frame-static", false)}${filterMarkup("mg-frame-active", true)}</defs>`;
  doc.body.append(svg);
  const active = svg.querySelector("#mg-frame-active")!;
  const displacement = active.querySelector("feDisplacementMap")!;
  const specular = active.querySelector("feComposite")!;
  let frame: Element | null = null;
  let offset = 0;
  let highlight = 0;
  let destroyed = false;

  function writeOptics(nextOffset: number, nextHighlight: number) {
    if (nextOffset !== offset) {
      offset = nextOffset;
      displacement.setAttribute("scale", String(__FRAME_EDGE_SCALE__ + offset));
    }
    if (nextHighlight !== highlight) {
      highlight = nextHighlight;
      // Only the refracting lip brightens; the flat interior of the profile is neutral grey.
      const gain = highlight / 255;
      specular.setAttribute("k3", String(gain));
      specular.setAttribute("k4", String((-128 / 255) * gain));
    }
  }

  function setFrame(next: Element | null) {
    if (destroyed) return;
    if (
      next &&
      (!root.contains(next) ||
        !next.isConnected ||
        !next.matches(
          "[data-glass-frame], [data-glass-frame-list] > .comparison-item, .topbar-actions > [data-glass-control], [data-motion-indicator]",
        ))
    )
      next = null;
    if (frame === next) return;
    frame?.removeAttribute("data-glass-frame-active");
    writeOptics(0, 0);
    frame = next;
    frame?.setAttribute("data-glass-frame-active", "");
  }

  const material = {
    setFrame,
    setOptics(press: number, velocity: number) {
      if (!frame?.isConnected) {
        setFrame(null);
        return;
      }
      const depth = Math.max(-0.15, Math.min(1.15, press));
      const speed = Math.min(1, Math.abs(velocity) / 12);
      writeOptics(
        Math.round(__FRAME_EDGE_SCALE__ * (0.48 * depth + 0.12 * speed)),
        Math.round(255 * (0.36 * depth + 0.12 * speed)),
      );
    },
    destroy() {
      if (destroyed) return;
      setFrame(null);
      destroyed = true;
      mounted.delete(doc);
      doc.documentElement.removeAttribute("data-frame-refraction");
      svg.remove();
    },
  };
  mounted.set(doc, { root, material });
  doc.documentElement.setAttribute("data-frame-refraction", "");
  return material;
}

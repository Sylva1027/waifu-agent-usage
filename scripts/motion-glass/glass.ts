// nordify/css-liquid-glass @ 00cfe6f9b15b72211853f190206bec6493907454, adapted for inset controls, visibility and live/baked optics.
import { createLiquidGlass } from "./nordify/liquid-glass";
import "./glass.css";

type Glass = {
  setOptics(press: number, velocity: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
};
const mounted = new WeakMap<HTMLElement, Glass>();

export function mountGlass(host: HTMLElement): Glass {
  const existing = mounted.get(host);
  if (existing) return existing;

  const corner = getComputedStyle(host).borderTopLeftRadius;
  const radius = corner.endsWith("%")
    ? (Math.min(host.clientWidth, host.clientHeight) * parseFloat(corner)) / 100
    : parseFloat(corner);
  const material = createLiquidGlass(host, { radius, fillParent: true, promote: false });
  const glass = {
    setVisible: material.setVisible,
    setOptics(press: number, velocity: number) {
      const depth = Math.max(-0.15, Math.min(1.15, press));
      const speed = Math.min(1, Math.abs(velocity) / 12);
      const highlight = Math.round((0.2 * depth + 0.1 * speed) * 255) / 255;
      material.setOptics(1 + 0.26 * depth + 0.08 * speed, highlight);
    },
    destroy() {
      if (mounted.get(host) !== glass) return;
      mounted.delete(host);
      material.destroy();
    },
  };
  mounted.set(host, glass);
  return glass;
}

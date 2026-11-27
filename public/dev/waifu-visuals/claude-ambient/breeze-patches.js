// All coordinates and offsets are in pixels of the accepted left-dark plate.
export const plate = { width: 1280, height: 1232 };
// Allow room for the soft lower-right cast shadow beyond the 144px material crop.
export const tile = 176;
export const firstPose = -3;
export const lastPose = 12;
export const patches = [
  { name: "low-fold", x: 216, y: 1078, center: [288, 1168], tilt: 0.55, lift: 3.0, delay: 0 },
  { name: "lower-fold", x: 417, y: 749, center: [495, 824], tilt: 0.63, lift: 4.0, delay: 1 },
  { name: "middle-fold", x: 556, y: 454, center: [633, 520], tilt: 0.4, lift: 3.4, delay: 2 },
  { name: "loose-leaf", x: 622, y: 384, delay: 2 },
  { name: "upper-fold", x: 627, y: 232, center: [704, 300], tilt: 0.31, lift: 3.1, delay: 4 },
];

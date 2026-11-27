"""Bake low-frequency illumination fields from the three registered Grok lamp studies.

Usage: python bake-lamp.py desk-dark.webp case.png desk.png board.png lamp-dark.webp
Requires NumPy and Pillow. All geometry is expressed in the original 2048 x 1152 plate.
"""
import sys

import numpy as np
from PIL import Image, ImageDraw

W, H, SCALE = 512, 288, 4
y, x = np.mgrid[:H, :W].astype(np.float32)
px, py = (x + 0.5) * SCALE, (y + 0.5) * SCALE

def plate(path):
    with Image.open(path) as image:
        if image.size != (W * SCALE, H * SCALE):
            raise ValueError(f"Unexpected plate size {image.size}: {path}")
        return np.asarray(image.convert("RGB").resize((W, H), Image.Resampling.BOX), dtype=np.float32)

def polygon(points):
    mask = Image.new("L", (W * SCALE, H * SCALE))
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return np.asarray(mask.resize((W, H), Image.Resampling.BOX), dtype=np.float32) / 255

def smooth(a, b, value):
    t = np.clip((value - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

def blur(field, radius):
    for _ in range(2):
        for axis in (0, 1):
            row = np.swapaxes(field, 0, axis)
            pad = [(radius + 1, radius)] + [(0, 0)] * (row.ndim - 1)
            sums = np.cumsum(np.pad(row, pad, mode="edge"), axis=0, dtype=np.float64)
            field = np.swapaxes((sums[2 * radius + 1:] - sums[:-2 * radius - 1]) / (2 * radius + 1), 0, axis)
    return field.astype(np.float32)

def exposure(original, study, mask, radius, fallback=0):
    # Normalize by the original on the same material. Never transfer generated texture or outlines.
    support = blur(mask, radius)[..., None]
    base, lit = (blur(p * mask[..., None], radius) for p in (original, study))
    stops = np.log2((lit + 4 * support + 0.001) / (base + 4 * support + 0.001))
    valid = smooth(0.01, 0.16, support)
    return fallback * (1 - valid) + stops * valid

def rotate_sample(field, angle):
    # Follow the rotating light across the leather. The camera and tabletop remain stationary.
    cx, cy = 35 / SCALE, -64 / SCALE
    dx, dy = x - cx, y - cy
    c, s = np.cos(angle), np.sin(angle)
    sx = np.clip(cx + c * dx - s * dy, 0, W - 1)
    sy = np.clip(cy + s * dx + c * dy, 0, H - 1)
    ix, iy = sx.astype(int), sy.astype(int)
    jx, jy = np.minimum(ix + 1, W - 1), np.minimum(iy + 1, H - 1)
    u, v = (sx - ix)[..., None], (sy - iy)[..., None]
    return ((1-v) * ((1-u) * field[iy,ix] + u * field[iy,jx]) +
            v * ((1-u) * field[jy,ix] + u * field[jy,jx]))

cloth = polygon([(0,0),(748,0),(628,32),(516,66),(443,87),(369,89),(341,95),
                 (302,119),(239,139),(160,169),(96,214),(43,261),(0,299)])
case = polygon([(0,559),(394,486),(404,489),(420,555),(405,772),(384,790),(0,866)])
board = polygon([(1574,0),(2048,0),(2048,262),(1689,295)])
mat = np.clip(1 - cloth - case - board, 0, 1)
# Estimate the board's incident light on its fixed surface. This shared field also lights the
# board repair, moving pawn and queen shadow, without imprinting their reference-frame silhouettes.
pieces = polygon([(1844,70),(1932,70),(1932,154),(2032,156),(2040,237),(1844,237)])
board_sample = board * (1 - pieces)
mat_mix = blur(mat, 1)[..., None]
materials = [(cloth, cloth, 4), (case, case, 5), (board, board_sample, 10)]
original, *studies = [plate(path) for path in sys.argv[1:5]]
keys = []
for index, study in enumerate(studies):
    far = exposure(original, study, mat, 32)
    field = exposure(original, study, mat, 9, far)
    if index == 1:
        field = np.minimum(field, 0) + 0.72 * np.maximum(field, 0)
    fixed = np.zeros_like(field)
    for region, sample, radius in materials:
        coarse = exposure(original, study, sample, 34)
        gain = exposure(original, study, sample, radius, coarse)
        fixed += blur(region, 1)[..., None] * gain
    keys.append((field, fixed))

# Protect the far desk from the generated plates' overall exposure changes.
reach = 1 - smooth(0.86, 1.20, py / 1152 + 0.28 * px / 2048)
alpha = np.rint(reach * 255).astype(np.uint8)
angles = np.deg2rad([71, 35, 8])
frames = []
for step in range(9):
    segment = min(step // 4, 1)
    t = (step - 4 * segment) / 4
    direction = (1-t)*angles[segment] + t*angles[segment+1]
    stops = np.zeros_like(original)
    for i, weight in ((segment, 1-t), (segment+1, t)):
        if weight:
            field, fixed = keys[i]
            stops += weight * (mat_mix * rotate_sample(field, angles[i] - direction) + fixed)
    # Overlay blending scales the existing dark tones; original highlights retain a shoulder.
    gain = np.exp2(np.clip(stops * 0.90, -1.55, 1.0))
    rgb = np.rint(np.minimum(255, 127.5 * gain)).astype(np.uint8)
    frames.append(np.dstack((rgb, alpha)))

rows = [np.concatenate(frames[i:i+3], axis=1) for i in range(0, 9, 3)]
Image.fromarray(np.concatenate(rows)).save(sys.argv[5], lossless=True, method=6)

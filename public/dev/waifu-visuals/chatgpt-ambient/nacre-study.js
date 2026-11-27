// Control curves follow the two rims of each visible overlap on the 720px reference.
// Each pair converges where the original fabric disappears underneath the next fold.
export const duration = 8;
export const rightDuration = 9.8;
const size = 720,
  columnCount = 120,
  subdivisions = 9;
const outlines = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [302, 275, 262, 243, 178, 126, 75, 21, 5, 5, 5, 5, 5],
  [370, 310, 268, 246, 222, 192, 139, 72, 49, 40, 40, 40, 40],
  [442, 399, 372, 355, 332, 305, 211, 169, 146, 137, 131, 128, 128],
  [461, 434, 401, 368, 335, 326, 320, 304, 284, 263, 250, 242, 242],
  [645, 620, 576, 542, 492, 436, 371, 335, 309, 283, 261, 248, 248],
  [683, 624, 580, 546, 511, 499, 494, 515, 518, 512, 500, 480, 470],
  [720, 720, 720, 720, 720, 720, 720, 720, 720, 720, 720, 720, 720],
];
const rowCount = (outlines.length - 1) * subdivisions + 1;
// Measured offsets at the exposed seam landmarks on the light 720px plate.
// Buried sections use the shared contour; both themes have the same layering.
const lightOffsets = [
  [],
  [0, 1, 0, 0, 0, 0, 3, 4],
  [1, 1, 0, 0, 0, 1, 2],
  [0, 1, 2, 1, 3, 1, -4],
  [0, 1, 0, 1, 3, 0, 4],
  [0, 1, 1, 0, 2, 0, 0],
  [1, 1, 1, 0, 0, 0, -1],
  [],
];
// The same photographed folds land in different places after the right crop and
// half turn. On that side the upper broad fold leads, followed by the lower lip.
const motion = {
  left: {
    freeEdges: [0, 24, 17, 32, 23, 43, 19, 0],
    delays: [0, 0.22, 0.68, 0.02, 0.84, 0.44, 1.1, 0],
  },
  right: {
    freeEdges: [0, 29, 17, 34, 21, 38, 23, 0],
    delays: [0, 0.36, 0.53, 0.09, 0.46, 0.04, 0.34, 0],
  },
};
const smooth = (n) => {
  const u = Math.max(0, Math.min(1, n));
  return u * u * (3 - 2 * u);
};
const lerp = (a, b, f) => a + (b - a) * f;
function current(t) {
  if (t <= 0 || t >= 5.45) return 0;
  const u = t / 5.45;
  return Math.sin(Math.PI * u) ** 2 * Math.sin(2 * Math.PI * u + 0.3);
}
// Monotone cubic interpolation follows each rim through its sparse landmarks.
function sampleCurve(points, x) {
  const i = Math.min(points.length - 2, Math.floor(x / 60)),
    u = x / 60 - i;
  const a = points[i],
    b = points[i + 1],
    d = b - a;
  const slope = (v, w) => (v * w > 0 ? (2 * v * w) / (v + w) : 0);
  const m = i ? slope(a - points[i - 1], d) : d;
  const n = i + 2 < points.length ? slope(d, points[i + 2] - b) : d;
  return lerp(a, b, smooth(u)) + u * (1 - u) * ((1 - u) * m - u * n);
}
function makeMesh(side, theme) {
  const right = side === "right";
  const screenDirection = right ? -1 : 1;
  const { freeEdges, delays } = motion[side];
  const contours =
    theme === "light" ? outlines.map((curve, k) => curve.map((y, i) => y + (lightOffsets[k][i] ?? 0))) : outlines;
  const columns = Array.from({ length: columnCount + 1 }, (_, c) => {
    const x = (c * size) / columnCount;
    const rims = contours.map((o) => sampleCurve(o, x));
    // The inner right field has faint folds under the cards. It moves before the
    // stronger outer folds, with smaller displacement in the crossfade.
    const freedom = right ? 1 - 0.78 * smooth((x - 130) / 560) : 1 - smooth((x - 130) / 415);
    const travel = right ? 1 + 2 * (1 - x / size) : (1.35 * x) / size;
    return { x, rims, freedom, travel };
  });
  const stride = 7,
    data = new Float32Array((columnCount + 1) * rowCount * stride);
  const heights = new Float32Array((columnCount + 1) * rowCount),
    triangles = [];
  const idx = (c, r) => c * rowCount + r;
  for (let c = 0; c < columnCount; c++)
    for (let r = 0; r < rowCount - 1; r++) {
      const i = idx(c, r);
      triangles.push(i, i + 1, i + rowCount, i + rowCount, i + 1, i + rowCount + 1);
    }
  function update(t) {
    for (let c = 0; c <= columnCount; c++) {
      const { x, rims, freedom, travel } = columns[c];
      const moved = rims.slice(),
        lift = new Float32Array(rims.length);
      for (let k = 1; k < rims.length - 1; k++) {
        const amount = freedom * freeEdges[k] * smooth(rims[k] / 55) * smooth((size - rims[k]) / 60);
        moved[k] += screenDirection * amount * current(t - travel - delays[k]);
        lift[k] = amount * 0.93 * current(t - travel - delays[k] - 0.21);
      }
      // The paired edges enclose a slit. Where it narrows, the leading edge pushes
      // its neighbour. At a tucked intersection both layers travel almost together.
      for (const k of [1, 3, 5]) {
        const gap = rims[k + 1] - rims[k];
        const freeGap = moved[k + 1] - moved[k];
        const resolved = Math.max(0.52 * gap, Math.min(gap + Math.min(23, 0.45 * gap), freeGap));
        const reaction = resolved - freeGap;
        moved[k] -= 0.42 * reaction;
        moved[k + 1] += 0.58 * reaction;
        const contact = 1 - smooth((resolved - 3) / 29);
        const delta = (lift[k + 1] - lift[k]) * contact;
        lift[k] += 0.42 * delta;
        lift[k + 1] -= 0.58 * delta;
      }
      for (let r = 0; r < rowCount; r++) {
        const k = Math.min(rims.length - 2, Math.floor(r / subdivisions)),
          v = (r - k * subdivisions) / subdivisions;
        const y = lerp(rims[k], rims[k + 1], v),
          span = rims[k + 1] - rims[k];
        const envelope = freedom * Math.sin(Math.PI * v) * smooth(span / 108);
        const phase = t - travel - lerp(delays[k], delays[k + 1], v) - 0.31 - 0.29 * v;
        const bow = envelope * current(phase);
        const j = idx(c, r),
          off = j * stride;
        // A fixed outer crop and stationary backing frame a travelling bend in the broad face.
        const shear =
          screenDirection *
          11 *
          bow *
          smooth(x / 50) *
          smooth((size - x) / 50) *
          smooth((size - y) / 90) *
          smooth(y / 90);
        data[off] = x + shear;
        data[off + 1] = lerp(moved[k], moved[k + 1], v) + screenDirection * 0.06 * span * bow;
        data[off + 2] = x / size;
        data[off + 3] = y / size;
        // Change the baked contact shadow only inside the original overlap.
        data[off + 6] =
          k % 2 === 1 ? (Math.sin(Math.PI * v) * (span - (moved[k + 1] - moved[k]))) / Math.max(8, span) : 0;
        heights[j] = lerp(lift[k], lift[k + 1], v) + 0.16 * span * envelope * current(phase - 0.15);
      }
    }
    // Surface normals come from the bent material. Uniform translation has zero slope.
    for (let c = 0; c <= columnCount; c++)
      for (let r = 0; r < rowCount; r++) {
        const j = idx(c, r),
          off = j * stride;
        const a = idx(Math.max(0, c - 1), r),
          b = idx(Math.min(columnCount, c + 1), r);
        const d = idx(c, Math.max(0, r - 1)),
          e = idx(c, Math.min(rowCount - 1, r + 1));
        const ux = data[b * stride] - data[a * stride],
          uy = data[b * stride + 1] - data[a * stride + 1],
          uz = heights[b] - heights[a];
        const vx = data[e * stride] - data[d * stride],
          vy = data[e * stride + 1] - data[d * stride + 1],
          vz = heights[e] - heights[d];
        const area = Math.max(0.01, ux * vy - uy * vx);
        data[off + 4] = (uz * vy - uy * vz) / area;
        data[off + 5] = (ux * vz - uz * vx) / area;
      }
    return data;
  }
  return { elements: new Uint16Array(triangles), update };
}
const vert = `
attribute vec2 position, texcoord, slope;
attribute float compression;
varying vec2 uv, tilt;
varying float slit;
void main(){
  uv=texcoord; tilt=slope; slit=compression;
  gl_Position=vec4(position.x/360.-1.,1.-position.y/360.,0.,1.);
}`;
const frag = `
precision highp float;
uniform sampler2D plate;
uniform float pearl, orientation;
uniform bool lightSilk;
varying vec2 uv, tilt;
varying float slit;
float opticalAngle(vec3 n, vec3 l) {
  float cosA=clamp(dot(n,l),0.,1.);
  return sqrt(1.-(1.-cosA*cosA)/(1.48*1.48));
}
vec3 nacre(float angle,float thickness) {
  vec3 phase=6.2831853*2.96*thickness*angle/vec3(640.,535.,450.);
  return cos(phase);
}
void main(){
  vec4 src=texture2D(plate,uv);
  vec3 neutral=normalize(vec3(orientation*vec2(-.26,-.36),1.)), light=normalize(vec3(-.49,-.47,.74));
  vec3 n=normalize(neutral+vec3(-orientation*tilt*neutral.z,0.));
  float luma=dot(src.rgb,vec3(.22,.67,.11));
  float turn=dot(n,light)-dot(neutral,light);
  float glancing=clamp(turn*.65,-.24,.24);
  float thickness=835.+35.*luma+12.*sin(12.*uv.x+7.*uv.y);
  vec3 spectral=nacre(opticalAngle(n,light),thickness)-nacre(opticalAngle(neutral,light),thickness);
  float response=smoothstep(.052,.32,luma);
  vec3 shift=spectral*vec3(.045,.023,.059);
  shift-=vec3(dot(shift,vec3(.22,.67,.11)));
  vec3 rgb=src.rgb*(1.+glancing)+pearl*shift*response;
  if(lightSilk){
    // White silk already reflects much of the key. Limit the gain to its
    // remaining headroom; turning away reveals its cooler diffuse shadow.
    vec3 lit=src.rgb+max(turn,0.)*.54*(1.-src.rgb)
      -min(max(-turn,0.),.62)*src.rgb*vec3(.30,.29,.24);
    float shade=clamp(slit,-.45,.48);
    lit-=max(shade,0.)*src.rgb*vec3(.18,.17,.13);
    lit+=max(-shade,0.)*(1.-src.rgb)*.23;
    // Silver mids carry the pink/blue shift. At grazing angles give the colour
    // room by rolling off the common white component, preserving chroma.
    vec3 iridescence=spectral*vec3(.090,.043,.108);
    iridescence-=vec3(dot(iridescence,vec3(.22,.67,.11)));
    float lustre=smoothstep(.33,.64,luma)*(1.-.49*smoothstep(.82,.99,luma));
    rgb=lit+pearl*lustre*iridescence;
    rgb-=max(0.,max(rgb.r,max(rgb.g,rgb.b))-1.);
  }
  gl_FragColor=vec4(clamp(rgb,0.,1.)*src.a,src.a);
}`;
function link(gl) {
  const p = gl.createProgram();
  for (const [kind, code] of [
    [gl.VERTEX_SHADER, vert],
    [gl.FRAGMENT_SHADER, frag],
  ]) {
    const sh = gl.createShader(kind);
    gl.shaderSource(sh, code);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(p, sh);
    gl.deleteShader(sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
export async function createStudy(canvas, side = "left", initialTheme = "dark") {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true });
  if (!gl) throw new Error("WebGL unavailable");
  const p = link(gl);
  gl.useProgram(p);
  gl.disable(gl.DITHER);
  const materials = new Map();
  function prepare(theme) {
    if (materials.has(theme)) return materials.get(theme).ready;
    const mat = { mesh: makeMesh(side, theme), texture: null };
    const image = new Image();
    image.src = `/assets/achievement-share/chatgpt/background-${theme}.webp`;
    mat.ready = image
      .decode()
      .then(() => {
        mat.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, mat.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      })
      .catch((err) => {
        materials.delete(theme);
        throw err;
      });
    materials.set(theme, mat);
    return mat.ready;
  }
  await prepare(initialTheme);
  const lightSilk = gl.getUniformLocation(p, "lightSilk");
  const material = gl.getUniformLocation(p, "pearl");
  gl.uniform1f(gl.getUniformLocation(p, "orientation"), side === "right" ? -1 : 1);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, materials.get(initialTheme).mesh.elements, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  for (const [i, field] of ["position", "texcoord", "slope", "compression"].entries()) {
    const loc = gl.getAttribLocation(p, field);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, field === "compression" ? 1 : 2, gl.FLOAT, false, 28, i * 8);
  }
  let valid = true;
  canvas.addEventListener("webglcontextlost", () => {
    valid = false;
    canvas.hidden = true;
  });
  function draw(seconds, withPearl = 1, theme = initialTheme) {
    if (!valid) return;
    const { mesh, texture } = materials.get(theme);
    // The photographic plate is 1254px square. Higher backing resolutions add no detail.
    const dpr = Math.min(devicePixelRatio, 1254 / Math.max(1, canvas.clientWidth, canvas.clientHeight));
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)),
      h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform1i(lightSilk, theme === "light" ? 1 : 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1f(material, withPearl);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.update(seconds), gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, mesh.elements.length, gl.UNSIGNED_SHORT, 0);
  }
  draw.prepare = prepare;
  return draw;
}

/* ============================================================
   The track: a closed spline sampled into evenly spaced points. Karts, cores and the AI all
   work in track coordinates (sample index + sideways offset).
   The world is a little park in the hills, built like a diorama:
   - a terrain mesh coloured per pixel from a data texture (paving, grass, water, road)
   - thousands of grass blades around the camera that sway in the wind and part around your kart
   - trees made of soft leaf puffs, bushes, rocks, lamps and wooden fences
   - a river into a pond that the road crosses on a stone bridge, and a hill it drives through
     in a tunnel (the hill turns see-through above your kart)
   ============================================================ */
import * as THREE from 'three';
import { Fn, texture, positionWorld, normalWorld, vec2, vec3, float, mix, color, attribute, vertexIndex, varying, step, uniform,
  cameraPosition, atan, rotateUV, mod, uv, fract, abs, floor, max } from 'three/tsl';
import { L, stylize, emissive, haloMat, noiseTex, windAt, foliageGeometry, foliageMaterial } from './look.js';
import { part, COLORS, trunkGeometry, rockGeometry, lamp, mergeAll } from './models.js';

// control points: x, z
const LAYOUT = [
  [-140, 0], [-40, 0], [60, 0], [140, 0], [205, -22], [248, -80], [262, -140], [258, -200], [236, -258], [190, -292], [132, -282],
  [98, -236], [56, -206], [8, -228], [-40, -282], [-95, -306], [-150, -306], [-200, -278], [-246, -226], [-258, -160], [-228, -108],
  [-258, -56], [-240, -8], [-196, 10],
];
export const HALF_W = 10;     // half the road width
const SPACING = 1;            // distance between samples
// the river (a polyline flowing into a pond), the hill with the tunnel
const RIVER = [[520, -60], [440, -96], [360, -128], [292, -150], [230, -152], [170, -138]], RIVER_HALF = 15, POND = { x:122, z:-132, r:40 };
const HILL = { x:-122, z:-336, r:104, h:36 }, TUNNEL_R = 62;
const WATER_Y = -1.4;
export const WORLD = { x0:-440, z0:-560, size:960 };
const RES = 640, TEX = WORLD.size / RES;   // data texels: 1.5 units each

export function mulberry(seed){ return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash = (x, z) => { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
function noise(x, z){
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi, u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function segDist(px, pz, ax, az, bx, bz){ const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz))); return Math.hypot(px - ax - dx * t, pz - az - dz * t); }
// distance to the water's edge line: negative inside the river or pond
const riverDist = (x, z) => { let d = Infinity; for (let i = 0; i + 1 < RIVER.length; i++) d = Math.min(d, segDist(x, z, ...RIVER[i], ...RIVER[i + 1]) - RIVER_HALF); return Math.min(d, Math.hypot(x - POND.x, z - POND.z) - POND.r); };
const hillDist = (x, z) => Math.hypot(x - HILL.x, z - HILL.z);
const toUV = xz => xz.sub(vec2(WORLD.x0, WORLD.z0)).div(WORLD.size);

export class Track {
  constructor(){
    const curve = new THREE.CatmullRomCurve3(LAYOUT.map(p => new THREE.Vector3(p[0], 0, p[1])), true, 'centripetal');
    this.length = curve.getLength();
    const N = this.N = Math.round(this.length / SPACING);
    const pts = curve.getSpacedPoints(N);
    this.P = []; this.T = []; this.R = [];
    for (let i = 0; i < N; i++){
      const p = pts[i], q = pts[(i + 1) % N];
      const t = new THREE.Vector3().subVectors(q, p).normalize();
      const r = new THREE.Vector3(-t.z, 0, t.x).normalize(); // sideways (right when facing along the track), level
      this.P.push(p); this.T.push(t); this.R.push(r);
    }
    // the road climbs gently onto the bridge, then smooth the heights so ramps feel soft
    const ys = this.P.map(p => .15 + 3.6 * sstep(RIVER_HALF + 34, RIVER_HALF - 6, riverDist(p.x, p.z) + RIVER_HALF));
    for (let pass = 0; pass < 8; pass++) for (let i = 0; i < N; i++) ys[i] = (ys[(i - 2 + N) % N] + ys[(i - 1 + N) % N] + ys[i] * 2 + ys[(i + 1) % N] + ys[(i + 2) % N]) / 6;
    this.P.forEach((p, i) => p.y = ys[i]);
    this.kind = this.P.map(p => hillDist(p.x, p.z) < TUNNEL_R ? 'tunnel' : riverDist(p.x, p.z) < 7 ? 'bridge' : 'ground');
    // turn rate at each sample, for the AI (how sharp the road bends ahead)
    this.bend = this.T.map((t, i) => { const u = this.T[(i + 12) % N]; return Math.atan2(t.x * u.z - t.z * u.x, t.x * u.x + t.z * u.z); });
    // a coarse grid of samples for fast "nearest road" lookups
    this.cell = 40; this.buckets = new Map();
    this.P.forEach((p, i) => { const k = Math.floor(p.x / this.cell) + ',' + Math.floor(p.z / this.cell); if (!this.buckets.has(k)) this.buckets.set(k, []); this.buckets.get(k).push(i); });
    this.buildFields();
  }
  wrap(i){ const N = this.N; return ((i % N) + N) % N; }
  // nearest sample to (x, z), searching around a hint index (karts move only a few samples a frame)
  nearest(x, z, hint, range = 40){
    let best = hint, bd = Infinity;
    if (hint == null || hint < 0){ const r = this.near(x, z, 2); return r.d < Infinity ? r.i : 0; }
    for (let k = -range; k <= range; k++){
      const i = this.wrap(hint + k), p = this.P[i], d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd){ bd = d; best = i; }
    }
    return best;
  }
  // nearest sample from the grid: { i, d } (d = Infinity when nothing within `rings` cells)
  near(x, z, rings = 2){
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell); let bi = -1, bd = Infinity;
    for (let a = -rings; a <= rings; a++) for (let b = -rings; b <= rings; b++){
      const l = this.buckets.get((cx + a) + ',' + (cz + b)); if (!l) continue;
      for (const i of l){ const p = this.P[i], d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd){ bd = d; bi = i; } }
    }
    return { i:bi, d:Math.sqrt(bd) };
  }
  // where (x, z) sits on the road: index, sideways offset, height and slope
  locate(x, z, hint){
    const i = this.nearest(x, z, hint), p = this.P[i], t = this.T[i], r = this.R[i];
    const dx = x - p.x, dz = z - p.z;
    const along = dx * t.x + dz * t.z, side = dx * r.x + dz * r.z;
    const j = this.wrap(i + (along >= 0 ? 1 : -1)), f = Math.min(1, Math.abs(along) / SPACING);
    const y = p.y + (this.P[j].y - p.y) * f;
    return { i, side, along, y, slope: this.P[(i + 1) % this.N].y - p.y };
  }
  pos(i, side = 0, out = new THREE.Vector3()){
    const k = this.wrap(Math.round(i)), p = this.P[k], r = this.R[k];
    return out.set(p.x + r.x * side, p.y, p.z + r.z * side);
  }
  heading(i){ const t = this.T[this.wrap(Math.round(i))]; return Math.atan2(t.x, t.z); }

  /* ---------- fields: distance to the road, ground height and the data texture ---------- */
  buildFields(){
    const D = this.D = new Float32Array(RES * RES).fill(1e9), I = this.I = new Int32Array(RES * RES).fill(-1);
    // stamp the distance to the road around every sample
    const rad = 46, rt = Math.ceil(rad / TEX);
    this.P.forEach((p, i) => {
      const ci = Math.floor((p.x - WORLD.x0) / TEX), cj = Math.floor((p.z - WORLD.z0) / TEX);
      for (let j = Math.max(0, cj - rt); j <= Math.min(RES - 1, cj + rt); j++) for (let k = Math.max(0, ci - rt); k <= Math.min(RES - 1, ci + rt); k++){
        const x = WORLD.x0 + (k + .5) * TEX, z = WORLD.z0 + (j + .5) * TEX, d = Math.hypot(x - p.x, z - p.z), n = j * RES + k;
        if (d < D[n]){ D[n] = d; I[n] = i; }
      }
    });
    const H = this.H = new Float32Array(RES * RES), data = new Uint8Array(RES * RES * 4);
    for (let j = 0; j < RES; j++) for (let k = 0; k < RES; k++){
      const n = j * RES + k, x = WORLD.x0 + (k + .5) * TEX, z = WORLD.z0 + (j + .5) * TEX, d = D[n], i = I[n];
      const kind = i >= 0 ? this.kind[i] : 'ground', ry = i >= 0 ? this.P[i].y : 0;
      // rolling ground, calm near the road, hills around the edge of the world
      const calm = sstep(14, 70, d);
      let h = (noise(x * .018, z * .018) * 1.6 + noise(x * .06, z * .06) * .4) * calm;
      const de = Math.hypot((x - 40) / 1.05, (z + 120) / .95);
      h += sstep(330, 450, de) * (18 + 14 * noise(x * .01, z * .01));
      const dh = hillDist(x, z);
      if (dh < HILL.r) h += HILL.h * (.5 + .5 * Math.cos(Math.PI * dh / HILL.r)) * (.9 + .2 * noise(x * .04, z * .04));
      // the river and pond
      const rd = riverDist(x, z);
      if (rd < 0) h += (-5.5 - h) * sstep(0, -9, rd);
      else h += .4 * sstep(0, 3, rd) * sstep(10, 3, rd); // a soft bank
      // the ground meets the road; the hill stays well above the tunnel
      if (kind === 'ground' && d < HALF_W + 24){ const w = sstep(HALF_W + 24, HALF_W + 4, d); h += (ry - .06 - h) * w; }
      if (kind === 'tunnel' && d < HALF_W + 10) h = Math.max(h, ry + 11.5);
      H[n] = h;
      // data: r paving, g grass, b water depth, a road
      const plaza = sstep(5, 0, Math.max(Math.abs(x + 140) - 48, Math.abs(z) - 30)) * (d > HALF_W + 1.5 ? 1 : 0);
      const n1 = noise(x * .05, z * .05), n2 = noise(x * .13 + 9, z * .13);
      let grass = sstep(-.55, -.15, n1 + n2 * .35) * sstep(HALF_W + 1.5, HALF_W + 5, d) * (1 - plaza) * sstep(WATER_Y + .1, WATER_Y + .9, h);
      if (dh < HILL.r * .45) grass *= .6;
      const wet = sstep(WATER_Y + .4, WATER_Y - 4, h);
      data[n * 4] = plaza * 255; data[n * 4 + 1] = grass * 255; data[n * 4 + 2] = wet * 255; data[n * 4 + 3] = d < HALF_W + .5 ? 255 : 0;
    }
    this.dataTex = new THREE.DataTexture(data, RES, RES, THREE.RGBAFormat);
    this.dataTex.magFilter = this.dataTex.minFilter = THREE.LinearFilter; this.dataTex.needsUpdate = true;
    const hh = new Uint16Array(RES * RES); for (let n = 0; n < hh.length; n++) hh[n] = THREE.DataUtils.toHalfFloat(H[n]);
    this.heightTex = new THREE.DataTexture(hh, RES, RES, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.magFilter = this.heightTex.minFilter = THREE.LinearFilter; this.heightTex.needsUpdate = true;
  }
  field(arr, x, z){
    const fx = (x - WORLD.x0) / TEX - .5, fz = (z - WORLD.z0) / TEX - .5, k = Math.max(0, Math.min(RES - 2, Math.floor(fx))), j = Math.max(0, Math.min(RES - 2, Math.floor(fz)));
    const u = Math.max(0, Math.min(1, fx - k)), v = Math.max(0, Math.min(1, fz - j)), n = j * RES + k;
    return arr[n] * (1 - u) * (1 - v) + arr[n + 1] * u * (1 - v) + arr[n + RES] * (1 - u) * v + arr[n + RES + 1] * u * v;
  }
  height(x, z){ return this.field(this.H, x, z); }
  roadDist(x, z){ const fx = Math.floor((x - WORLD.x0) / TEX), fz = Math.floor((z - WORLD.z0) / TEX); if (fx < 0 || fz < 0 || fx >= RES || fz >= RES) return 1e9; return this.D[fz * RES + fx]; }
  inSlot(x, z){ const n = this.near(x, z, 1); return n.i >= 0 && n.d < HALF_W + 9 && this.kind[n.i] === 'tunnel'; }

  /* ---------- the scene ---------- */
  build(scene, quality){
    const root = this.root = new THREE.Group(); scene.add(root);
    this.quality = quality;
    const rng = mulberry(20251025);
    this.buildGround(root, quality);
    this.buildWater(root);
    this.buildRoad(root);
    this.buildBridge(root);
    this.buildTunnel(root);
    this.buildStart(root, rng);
    this.buildFences(root);
    this.buildLamps(root);
    this.buildNature(root, rng, quality);
    this.buildGrass(root, quality);
  }

  // terrain colour per pixel: dirt, grass, paving slabs, rock on steep slopes, darker where wet
  groundColor(data){
    const p = positionWorld.xz, n = texture(noiseTex, p.mul(.011)).r, n2 = texture(noiseTex, p.mul(.05)).r;
    const dirt = mix(color('#a8687a'), color('#8a5670'), n2);
    const grass = mix(color('#b8b62e'), color('#d4c13a'), n.smoothstep(.3, .75));
    let c = mix(dirt, grass, data.g);
    // paving: big square slabs, each a slightly different tone, with dark joints
    const q = p.div(4), cell = texture(noiseTex, floor(q).mul(.137)).r, f = fract(q), joint = step(.95, max(f.x, f.y));
    const slab = mix(mix(color('#ffcf8b'), color('#f0b27e'), cell), color('#c98a6c'), joint);
    c = mix(c, slab, data.r);
    c = mix(c, color('#7c5a66'), data.b);
    return c;
  }
  buildGround(root, quality){
    const segs = quality === 'low' ? 240 : 320, S = WORLD.size;
    const g = new THREE.PlaneGeometry(S, S, segs, segs).rotateX(-Math.PI / 2).translate(WORLD.x0 + S / 2, 0, WORLD.z0 + S / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, this.height(p.getX(i), p.getZ(i)));
    g.computeVertexNormals();
    const data = texture(this.dataTex, toUV(positionWorld.xz));
    // rock shows on the steep faces of the hills
    const steep = normalWorld.y.smoothstep(.86, .6);
    const col = mix(this.groundColor(data), mix(color('#c98f8a'), color('#a77089'), texture(noiseTex, positionWorld.xz.mul(.03)).r), steep);
    const m = stylize(col, { shadow:data.g.mul(.3), bounce:false, cut:true });
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; root.add(mesh);
    this.ground = mesh;
  }
  buildWater(root){
    const S = WORLD.size;
    const g = new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2).translate(WORLD.x0 + S / 2, WATER_Y, WORLD.z0 + S / 2);
    const depth = float(WATER_Y).sub(texture(this.heightTex, toUV(positionWorld.xz)).r);
    const ripple = texture(noiseTex, positionWorld.xz.mul(.04).add(vec2(L.time.mul(.02), L.time.mul(.013)))).r;
    const foam = step(depth.add(ripple.sub(.5).mul(.5)), .45);
    const col = mix(mix(color('#7fe3cf'), color('#1f4a8a'), depth.div(4.5).clamp(0, 1)), color('#f4ecff'), foam);
    const m = stylize(col, { normal:vec3(0, 1, 0), core:false, bounce:false });
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; root.add(mesh);
  }

  // a ribbon along the track between two sideways offsets
  // (faces up, or down when `up` is false)
  ribbon(a, b, y = .04, from = 0, to = this.N, uvScale = 1, up = true){
    const pos = [], uvs = [], ind = [];
    let v = 0;
    for (let k = from; k <= to; k++){
      const i = this.wrap(k), p = this.P[i], r = this.R[i];
      pos.push(p.x + r.x * a, p.y + y, p.z + r.z * a, p.x + r.x * b, p.y + y, p.z + r.z * b);
      uvs.push(0, v * uvScale, 1, v * uvScale); v += SPACING;
      if (k < to){ const n = (k - from) * 2; ind.push(n, n + 2, n + 1, n + 1, n + 2, n + 3); }
    }
    // which way the first triangle faces decides the winding
    const P = i => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const ny = P(2).sub(P(0)).cross(P(1).sub(P(0))).y;
    if ((ny > 0) !== up) for (let i = 0; i < ind.length; i += 3){ const t = ind[i + 1]; ind[i + 1] = ind[i + 2]; ind[i + 2] = t; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(ind);
    g.computeVertexNormals(); return g;
  }
  buildRoad(root){
    // asphalt with a little grain, white edge lines and a dashed centre line
    const u = uv().x, v = uv().y, grain = texture(noiseTex, positionWorld.xz.mul(.09)).r;
    let c = mix(color('#463f35'), color('#54493d'), grain);
    const edge = step(.965, abs(u.sub(.5)).mul(2)), dash = step(abs(u.sub(.5)), .008).mul(step(fract(v.div(9)), .5));
    c = mix(c, color('#efe2cf'), max(edge.mul(step(abs(u.sub(.5)).mul(2), .985)), dash));
    const road = new THREE.Mesh(this.ribbon(-HALF_W, HALF_W), stylize(c, { normal:vec3(0, 1, 0), core:false, bounce:false }));
    road.receiveShadow = true; root.add(road);
    // kerbs: red and white blocks on both edges, flat on the ground
    for (const s of [-1, 1]){
      const g = this.ribbon(s * HALF_W, s * (HALF_W + 1.4), .06);
      const stripe = step(fract(uv().y.div(6)), .5);
      const k = new THREE.Mesh(g, stylize(mix(color('#ff4e5b'), color('#fff1e4'), stripe), { normal:vec3(0, 1, 0), core:false, bounce:false, side:THREE.DoubleSide }));
      k.receiveShadow = true; root.add(k);
    }
  }
  sections(kind){
    const out = []; let s = -1;
    for (let i = 0; i < this.N; i++){ const on = this.kind[i] === kind; if (on && s < 0) s = i; if (!on && s >= 0){ out.push([s, i - 1]); s = -1; } }
    if (s >= 0) out.push([s, this.N - 1]);
    return out;
  }
  buildBridge(root){
    const stone = stylize('#d7c3d6'), dark = stylize('#a58aa6');
    for (const [a, b] of this.sections('bridge')){
      const i0 = a - 10, i1 = b + 10;
      // deck: a thick slab under the road
      const deck = this.ribbon(-HALF_W - 2.2, HALF_W + 2.2, -.05, i0, i1);
      const under = this.ribbon(HALF_W + 2.2, -HALF_W - 2.2, -1.6, i0, i1, 1, false);
      root.add(Object.assign(new THREE.Mesh(deck, stone), { receiveShadow:true }), Object.assign(new THREE.Mesh(under, dark), { castShadow:true }));
      for (const s of [-1, 1]){
        // deck side and a low parapet wall with caps
        const side = this.wall(s * (HALF_W + 2.2), -1.6, -.05, i0, i1, s); root.add(Object.assign(new THREE.Mesh(side, dark), { receiveShadow:true }));
        const wall = this.wall(s * (HALF_W + 1.6), 0, 1.1, i0, i1, -s), wall2 = this.wall(s * (HALF_W + 2.2), 0, 1.1, i0, i1, s);
        for (const w of [wall, wall2]) root.add(Object.assign(new THREE.Mesh(w, stone), { castShadow:true, receiveShadow:true }));
        root.add(Object.assign(new THREE.Mesh(this.ribbon(s * (HALF_W + 1.4), s * (HALF_W + 2.4), 1.15, i0, i1), stylize('#f0e2ee', { side:THREE.DoubleSide })), { castShadow:true, receiveShadow:true }));
      }
      // piers down into the water
      for (let k = i0 + 6; k <= i1 - 6; k += 14){
        const i = this.wrap(k), p = this.P[i];
        for (const s of [-1, 1]){
          const x = p.x + this.R[i].x * s * (HALF_W - 2), z = p.z + this.R[i].z * s * (HALF_W - 2);
          root.add(part(new THREE.CylinderGeometry(1.2, 1.5, p.y + 7, 8), dark, x, (p.y - 7) / 2 - .8, z));
        }
      }
    }
  }
  // a vertical strip along the track at sideways offset `s`, from height y0 to y1, facing `face` (+1 right, -1 left)
  wall(s, y0, y1, from, to, face){
    const pos = [], ind = [];
    for (let k = from; k <= to; k++){
      const i = this.wrap(k), p = this.P[i], r = this.R[i];
      pos.push(p.x + r.x * s, p.y + y0, p.z + r.z * s, p.x + r.x * s, p.y + y1, p.z + r.z * s);
      if (k < to){ const n = (k - from) * 2; if (face > 0) ind.push(n, n + 2, n + 1, n + 1, n + 2, n + 3); else ind.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(ind); g.computeVertexNormals(); return g;
  }
  buildTunnel(root){
    for (const [a, b] of this.sections('tunnel')){
      const i0 = a - 3, i1 = b + 3, span = i1 - i0, R = HALF_W + 2.5, M = 16;
      const pos = [], ind = [];
      for (let k = 0; k <= span; k++){
        const i = this.wrap(i0 + k), p = this.P[i], r = this.R[i];
        const ring = [[-R, -.5], [-R, 3.5]];
        for (let s = 1; s < M; s++){ const t = Math.PI - Math.PI * s / M; ring.push([Math.cos(t) * R, 3.5 + Math.sin(t) * R * .62]); }
        ring.push([R, 3.5], [R, -.5]);
        for (const [sx, sy] of ring) pos.push(p.x + r.x * sx, p.y + sy, p.z + r.z * sx);
        if (k < span){ const Lr = ring.length, o = k * Lr; for (let j = 0; j < Lr - 1; j++) ind.push(o + j, o + Lr + j, o + j + 1, o + j + 1, o + Lr + j, o + Lr + j + 1); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(ind); g.computeVertexNormals();
      const tube = new THREE.Mesh(g, stylize('#6b5a78', { side:THREE.DoubleSide, cut:true, core:false })); tube.receiveShadow = true; root.add(tube);
      // warm light strips along both walls and lamps in the roof
      for (const s of [-1, 1]) root.add(new THREE.Mesh(this.wall(s * (R - .05), 2.2, 2.6, i0 + 2, i1 - 2, -s), emissive(s > 0 ? '#ffb15a' : '#ff6fd0', 1.6)));
      const roofG = new THREE.BoxGeometry(3.2, .25, 1.2), roofM = emissive('#fff0d0', 1.8, { cut:true });
      for (let k = 4; k < span - 3; k += 7){
        const i = this.wrap(i0 + k), p = this.P[i], l = new THREE.Mesh(roofG, roofM);
        l.position.set(p.x, p.y + 3.5 + R * .62 - .2, p.z); l.rotation.y = this.heading(i); root.add(l);
      }
      // portals: a stone arch and a rock face around each end
      for (const [k, dir] of [[0, 1], [span, -1]]){
        const i = this.wrap(i0 + k), p = this.P[i], h = this.heading(i);
        const opening = (sh, r) => { sh.lineTo(-r, -1); sh.lineTo(-r, 3.5); sh.absellipse(0, 3.5, r, r * .62, Math.PI, 0, true); sh.lineTo(r, -1); };
        const W = R + 14, face = new THREE.Shape(); face.moveTo(-W, -1); opening(face, R);
        for (const [fx, fy] of [[W, -1], [W * .92, 7], [W * .6, 13], [W * .2, 15.5], [-W * .25, 15], [-W * .62, 12], [-W * .9, 6]]) face.lineTo(fx, fy);
        face.closePath();
        const fm = new THREE.Mesh(new THREE.ExtrudeGeometry(face, { depth:5, bevelEnabled:false }), stylize('#c98f8a', { cut:true }));
        fm.position.set(p.x, p.y, p.z); fm.rotation.y = h; fm.translateZ(dir > 0 ? -1.5 : -3.5); fm.castShadow = fm.receiveShadow = true; root.add(fm);
        const arch = new THREE.Shape(); arch.moveTo(-R - 1.6, -1); opening(arch, R); arch.lineTo(R + 1.6, -1); arch.lineTo(R + 1.6, 3.5); arch.absellipse(0, 3.5, R + 1.6, R * .62 + 1.6, 0, Math.PI, false); arch.closePath();
        const am = new THREE.Mesh(new THREE.ExtrudeGeometry(arch, { depth:6, bevelEnabled:true, bevelSize:.3, bevelThickness:.3, bevelSegments:1 }), stylize('#e8d6e6', { cut:true }));
        am.position.set(p.x, p.y, p.z); am.rotation.y = h; am.translateZ(-3); am.castShadow = am.receiveShadow = true; root.add(am);
      }
    }
  }
  buildStart(root, rng){
    const i = 4, p = this.P[i], h = this.heading(i), r = this.R[i];
    // chequered line
    const c = document.createElement('canvas'); c.width = 160; c.height = 16; const g = c.getContext('2d');
    for (let x = 0; x < 20; x++) for (let y = 0; y < 2; y++){ g.fillStyle = (x + y) % 2 ? '#2a2233' : '#fff4e6'; g.fillRect(x * 8, y * 8, 8, 8); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, 2.4).rotateX(-Math.PI / 2), stylize(texture(tex).rgb, { normal:vec3(0, 1, 0), core:false }));
    line.position.set(p.x, p.y + .07, p.z); line.rotation.y = h; line.receiveShadow = true; root.add(line);
    // gate: two pillars, a beam with the name, and five start lights
    const gate = new THREE.Group(); gate.position.set(p.x, p.y, p.z); gate.rotation.y = h + Math.PI / 2; root.add(gate);
    for (const s of [-1, 1]){ gate.add(part(new THREE.BoxGeometry(1.6, 9, 1.6), '#3a2f48', 0, 4.5, s * (HALF_W + 2.2))); gate.add(part(new THREE.BoxGeometry(2.4, .8, 2.4), '#3a2f48', 0, .4, s * (HALF_W + 2.2))); }
    gate.add(part(new THREE.BoxGeometry(1.4, 2.2, HALF_W * 2 + 6), '#3a2f48', 0, 9.6, 0));
    const bc = document.createElement('canvas'); bc.width = 512; bc.height = 96; const bg = bc.getContext('2d');
    bg.fillStyle = '#2a2233'; bg.fillRect(0, 0, 512, 96); bg.fillStyle = '#fff4e6'; bg.font = '900 62px Nunito, Arial Black, sans-serif'; bg.textAlign = 'center'; bg.textBaseline = 'middle'; bg.fillText('TEKRACERS', 256, 52);
    const bt = new THREE.CanvasTexture(bc); bt.colorSpace = THREE.SRGBColorSpace;
    for (const s of [-1, 1]){ const banner = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 1.6, 1.9), emissive('#ffffff', 1, {})); banner.material = new THREE.MeshBasicNodeMaterial({ map:bt }); banner.position.set(s * .72, 9.6, 0); banner.rotation.y = s * Math.PI / 2; gate.add(banner); }
    this.startLights = [];
    for (let k = 0; k < 5; k++){ const l = part(new THREE.SphereGeometry(.42, 12, 8), emissive('#4a1f2c', 1), -.75, 8.0, (k - 2) * 1.3, false); gate.add(l); this.startLights.push(l); }
    // a little grandstand with a crowd beside the start
    const stand = new THREE.Group(); stand.position.set(p.x + r.x * (HALF_W + 18) - this.T[i].x * 10, p.y, p.z + r.z * (HALF_W + 18) - this.T[i].z * 10); stand.rotation.y = h + Math.PI / 2; root.add(stand);
    for (let s = 0; s < 4; s++) stand.add(part(new THREE.BoxGeometry(3, 1.1, 34), s % 2 ? '#e6d2c0' : '#d7bfae', s * 2.6, .55 + s * 1.1, 0));
    stand.add(part(new THREE.BoxGeometry(12, .5, 36), '#3a2f48', 3.9, 6.6, 0));
    for (const z of [-17, 17]) for (const x of [-1, 9]) stand.add(part(new THREE.BoxGeometry(.4, 6.4, .4), '#3a2f48', x, 3.2, z));
    const fans = ['#ff5a4e', '#3f8cff', '#ffbe3b', '#3fd68a', '#b36bff', '#fff4e6'];
    for (const col of fans){
      const im = new THREE.InstancedMesh(new THREE.CapsuleGeometry(.36, .5, 2, 6), stylize(col), 22); const o = new THREE.Object3D(); let n = 0;
      for (let q = 0; q < 22; q++){ const s = rng() * 4 | 0; o.position.set(s * 2.6 + (rng() - .5) * .8, 1.1 + s * 1.1 + .7, (rng() - .5) * 32); o.updateMatrix(); im.setMatrixAt(n++, o.matrix); }
      im.castShadow = true; stand.add(im);
    }
  }
  // wooden fences along the road edges (not on the bridge, in the tunnel or along the plaza)
  buildFences(root){
    const posts = [], rails = [], o = new THREE.Object3D();
    for (const s of [-1, 1]){
      let last = null;
      for (let i = 0; i < this.N; i += 4){
        const p = this.P[i], r = this.R[i], x = p.x + r.x * s * (HALF_W + 3), z = p.z + r.z * s * (HALF_W + 3);
        const plaza = Math.abs(p.x + 50) < 150 && Math.abs(p.z) < 34;
        if (this.kind[i] !== 'ground' || plaza || this.kind[this.wrap(i + 6)] !== 'ground' || this.kind[this.wrap(i - 6)] !== 'ground'){ last = null; continue; }
        const y = this.height(x, z);
        posts.push([x, y, z]);
        if (last){ const dx = x - last[0], dz = z - last[2]; rails.push([(x + last[0]) / 2, (y + last[1]) / 2, (z + last[2]) / 2, Math.atan2(dx, dz), Math.hypot(dx, dz)]); }
        last = [x, y, z];
      }
    }
    const wood = stylize(COLORS.wood);
    const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(.32, 1.5, .32), wood, posts.length);
    posts.forEach(([x, y, z], n) => { o.position.set(x, y + .75, z); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); o.updateMatrix(); pm.setMatrixAt(n, o.matrix); });
    const rm = new THREE.InstancedMesh(new THREE.BoxGeometry(.16, .2, 1), wood, rails.length * 2);
    rails.forEach(([x, y, z, a, l], n) => { for (const [q, hy] of [[0, .55], [1, 1.15]]){ o.position.set(x, y + hy, z); o.rotation.set(0, a, 0); o.scale.set(1, 1, l + .1); o.updateMatrix(); rm.setMatrixAt(n * 2 + q, o.matrix); } });
    for (const m of [pm, rm]){ m.castShadow = m.receiveShadow = true; root.add(m); }
  }
  buildLamps(root){
    this.lamps = [];
    for (let i = 20, s = 1; i < this.N; i += 46, s = -s){
      if (this.kind[i] === 'tunnel') continue;
      const p = this.P[i], r = this.R[i], off = this.kind[i] === 'bridge' ? HALF_W + 1.9 : HALF_W + 4.4;
      const x = p.x + r.x * s * off, z = p.z + r.z * s * off, y = this.kind[i] === 'bridge' ? p.y + 1.1 : this.height(x, z);
      const l = lamp(); l.position.set(x, y, z); root.add(l);
      const halo = new THREE.Sprite(haloMat('#ffb766')); halo.scale.setScalar(7); halo.position.set(x, y + 6.1, z); root.add(halo);
      this.lamps.push(l);
    }
  }

  /* ---------- trees, bushes and rocks ---------- */
  buildNature(root, rng, quality){
    const lots = quality === 'low' ? .6 : 1;
    const free = (x, z, m) => this.roadDist(x, z) > HALF_W + m && riverDist(x, z) > 3 && Math.abs(x - WORLD.x0 - WORLD.size / 2) < WORLD.size / 2 - 20 && Math.abs(z - WORLD.z0 - WORLD.size / 2) < WORLD.size / 2 - 20 && !(Math.abs(x + 50) < 156 && Math.abs(z) < 40);
    // groves: [centre x, z, radius, count, palette]
    const P = { cherry:['#e2566e', '#ffb2a3'], autumn:['#df5a2c', '#ffb04a'], gold:['#d09a1c', '#ffe46a'], green:['#3d9a5a', '#b2e05a'], plum:['#7a3fa0', '#e889d8'] };
    const groves = [[110, -150, 95, 46, 'cherry'], [-300, -130, 95, 44, 'autumn'], [-60, -150, 80, 30, 'green'], [320, -260, 110, 38, 'gold'],
      [40, 110, 130, 40, 'cherry'], [-120, -440, 90, 26, 'plum'], [180, -380, 90, 28, 'green'], [-320, 60, 90, 26, 'gold'], [330, 60, 100, 28, 'autumn'],
      [-40, -360, 60, 12, 'green'], [-200, -400, 60, 12, 'autumn']];
    const trees = [], bushes = [];
    for (const [cx, cz, rad, cnt, pal] of groves){
      let placed = 0, tries = 0;
      while (placed < cnt * lots && tries++ < cnt * 30){
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * rad, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (!free(x, z, 8) || trees.some(t => Math.hypot(t.x - x, t.z - z) < 7)) continue;
        trees.push({ x, z, y:this.height(x, z), s:.8 + rng() * .6, pal }); placed++;
      }
      for (let b = 0; b < cnt * .8 * lots; b++){
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * rad * 1.1, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (free(x, z, 4.5)) bushes.push({ x, z, y:this.height(x, z), s:.9 + rng() * 1.1, pal: rng() < .6 ? 'green' : pal });
      }
    }
    // bushes along the road edges too
    for (let i = 0; i < this.N; i += 9){
      if (this.kind[i] !== 'ground' || rng() < .45) continue;
      const s = rng() < .5 ? -1 : 1, off = HALF_W + 5.5 + rng() * 5, p = this.P[i], r = this.R[i], x = p.x + r.x * s * off, z = p.z + r.z * s * off;
      if (free(x, z, 4.5)) bushes.push({ x, z, y:this.height(x, z), s:.8 + rng() * .8, pal: ['green', 'cherry', 'gold'][rng() * 3 | 0] });
    }
    this.trees = trees;
    // trunks
    const o = new THREE.Object3D(), tg = trunkGeometry();
    const tm = new THREE.InstancedMesh(tg, stylize('#8f5b4d', { cut:true }), trees.length);
    trees.forEach((t, n) => { o.position.set(t.x, t.y - .2, t.z); o.rotation.set(0, rng() * 6.3, 0); o.scale.set(7 * t.s, 7 * t.s, 7 * t.s); o.updateMatrix(); tm.setMatrixAt(n, o.matrix); });
    tm.castShadow = tm.receiveShadow = true; root.add(tm);
    // leaf puffs, one instanced mesh per palette
    const fg = foliageGeometry(quality === 'low' ? 34 : 64, rng), groups = {};
    const add = (pal, x, y, z, s) => (groups[pal] = groups[pal] || []).push([x, y, z, s]);
    for (const t of trees){
      const top = t.y + 6.2 * t.s, s = 3.1 * t.s;
      add(t.pal, t.x, top, t.z, s * 1.15);
      for (let k = 0; k < 3; k++){ const a = rng() * 6.3; add(t.pal, t.x + Math.cos(a) * s * .75, top - s * (.25 + rng() * .3), t.z + Math.sin(a) * s * .75, s * (.7 + rng() * .2)); }
    }
    for (const b of bushes) add(b.pal, b.x, b.y + b.s * .55, b.z, b.s * 1.25);
    for (const pal in groups){
      const list = groups[pal], im = new THREE.InstancedMesh(fg, foliageMaterial(P[pal][0], P[pal][1]), list.length);
      list.forEach(([x, y, z, s], n) => { o.position.set(x, y, z); o.rotation.set(rng() * 6.3, rng() * 6.3, 0); o.scale.setScalar(s); o.updateMatrix(); im.setMatrixAt(n, o.matrix); });
      im.castShadow = im.receiveShadow = true; root.add(im);
    }
    // rocks: scattered pebbles, and boulders around the hill
    const rocks = [];
    for (let k = 0; k < 170 * lots; k++){
      const x = WORLD.x0 + 40 + rng() * (WORLD.size - 80), z = WORLD.z0 + 40 + rng() * (WORLD.size - 80);
      if (free(x, z, 3)) rocks.push([x, this.height(x, z), z, .5 + rng() * 1.3]);
    }
    for (let k = 0; k < 40; k++){
      const a = rng() * 6.3, d = HILL.r * (.55 + rng() * .5), x = HILL.x + Math.cos(a) * d, z = HILL.z + Math.sin(a) * d;
      if (free(x, z, 5)) rocks.push([x, this.height(x, z), z, 2 + rng() * 3]);
    }
    const rk = new THREE.InstancedMesh(rockGeometry(rng), stylize('#cdbfd8', { cut:true }), rocks.length);
    rocks.forEach(([x, y, z, s], n) => { o.position.set(x, y + s * .3, z); o.rotation.set(rng() * 6, rng() * 6, rng() * 6); o.scale.set(s, s * .7, s); o.updateMatrix(); rk.setMatrixAt(n, o.matrix); });
    rk.castShadow = rk.receiveShadow = true; root.add(rk);
  }

  /* ---------- grass: blades around the camera, wrapped so they follow it ---------- */
  buildGrass(root, quality){
    const sub = quality === 'low' ? 150 : 230, size = 116, count = sub * sub, cell = size / sub;
    const blade = new Float32Array(count * 9), dummy = new Float32Array(count * 9);
    let n = 0;
    for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++){
      const x = (i / sub - .5) * size + (Math.random() - .5) * cell, z = (j / sub - .5) * size + (Math.random() - .5) * cell, r = Math.random();
      for (let v = 0; v < 3; v++){ blade[n++] = x; blade[n++] = z; blade[n++] = r; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(dummy, 3));
    g.setAttribute('blade', new THREE.Float32BufferAttribute(blade, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.grassCenter = uniform(new THREE.Vector2());
    const S = float(size), tip = varying(step(vertexIndex.toFloat().mod(3), .5)), corner = vertexIndex.toFloat().mod(3);
    const wpos = varying(vec2());
    const position = Fn(() => {
      const b = attribute('blade', 'vec3');
      const loop = b.xy.sub(this.grassCenter), half = S.mul(.5);
      const xz = vec2(mod(loop.x.add(half), S).sub(half), mod(loop.y.add(half), S).sub(half)).add(this.grassCenter).toVar();
      wpos.assign(xz);
      const uvw = toUV(xz), data = texture(this.dataTex, uvw), gy = texture(this.heightTex, uvw).r;
      const amount = data.g, vary = texture(noiseTex, xz.mul(.021)).r.add(.45);
      const h = float(1.15).mul(b.z.mul(.6).add(.4)).mul(vary).mul(amount);
      const w = float(.22).mul(amount);
      // three corners: tip, left, right; turned to face the camera
      const sx = corner.equal(0).select(0, corner.equal(1).select(w, w.negate())), sy = tip.mul(h);
      const ang = atan(xz.y.sub(cameraPosition.z), xz.x.sub(cameraPosition.x)).add(-Math.PI / 2);
      const off = rotateUV(vec2(sx, 0), ang, vec2(0));
      // wind, and blades bending away from the kart this view follows
      const wind = windAt(xz).mul(tip).mul(h).mul(1.6);
      const away = xz.sub(L.cut.xz), dist = away.length(), push = dist.smoothstep(4, 1.2).mul(tip).mul(h).mul(1.1);
      const bend = wind.add(away.div(dist.max(.01)).mul(push));
      const hidden = step(amount, .38).mul(-200);
      return vec3(xz.x.add(off.x).add(bend.x), gy.add(sy).sub(push.mul(.4)).add(hidden), xz.y.add(off.y).add(bend.y));
    })();
    const data = texture(this.dataTex, toUV(wpos));
    const col = mix(color('#b8b62e'), color('#d9c642'), texture(noiseTex, wpos.mul(.011)).r.smoothstep(.3, .75));
    const m = stylize(mix(col, color('#e8d070'), tip.mul(.25)), { normal:vec3(0, 1, 0), shadow:tip.oneMinus().mul(.55).mul(data.g), position, bounce:false, side:THREE.DoubleSide, cut:true });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
    root.add(mesh); this.grass = mesh;
  }
  // lights on the start gate: count 3, 2, 1 turns red ones on; 0 is GO (all green); -1 is off
  setStartLights(n){
    const lit = n === 0 ? 5 : n >= 3 ? 2 : n === 2 ? 4 : 5;
    this.startLights.forEach((l, i) => l.material = n === 0 ? emissive('#3dff8a', 2.2) : n > 0 && i < lit ? emissive('#ff2a3c', 2.2) : emissive('#4a1f2c', 1));
  }
}

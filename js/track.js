/* ============================================================
   The track: a closed spline sampled into evenly spaced points. Karts, cores and the AI all
   work in track coordinates (sample index + sideways offset).
   The world is a sunset canyon: a low-poly desert heightfield with a river canyon the road
   crosses on a steel arch bridge, a mountain it drives through in a lit tunnel, mesas,
   pylons, billboards and a neon start gantry.
   ============================================================ */
import * as THREE from 'three';
import { mat, glow, part, rock, mesa, pine, cactus, shrub, pylon, COLORS } from './models.js';

// control points: x, z, height
const LAYOUT = [
  [0, 0, 0], [90, 0, 0], [165, -14, 0], [222, -62, 2], [244, -132, 7], [234, -205, 9], [222, -262, 9], [212, -322, 9],
  [190, -380, 5], [135, -420, 0], [62, -410, 0], [18, -360, 0], [-40, -322, 0], [-110, -312, 0], [-180, -322, 0],
  [-236, -282, 0], [-262, -204, 0], [-222, -150, 0], [-254, -96, 0], [-226, -36, 0], [-160, 2, 0], [-80, 14, 0],
];
export const HALF_W = 10;     // half the road width
const SPACING = 1;            // distance between samples
// the river canyon (a polyline) and the mountain with the tunnel
const CANYON = [[40, -140], [140, -222], [262, -262], [380, -248], [520, -300], [760, -330]], CANYON_HALF = 36, CANYON_FLOOR = 15, CANYON_DEPTH = -32;
const MOUNTAIN = { x:-112, z:-318, r:165, h:95 }, TUNNEL_R = 80;
export const WORLD = { cx:0, cz:-200, size:1900 };

export function mulberry(seed){ return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// smooth value noise in [-1, 1]
const hash = (x, z) => { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
function noise(x, z){
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi, u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function segDist(px, pz, ax, az, bx, bz){ const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz))); return Math.hypot(px - ax - dx * t, pz - az - dz * t); }
const canyonDist = (x, z) => { let d = Infinity; for (let i = 0; i + 1 < CANYON.length; i++) d = Math.min(d, segDist(x, z, ...CANYON[i], ...CANYON[i + 1])); return d; };

export class Track {
  constructor(){
    const curve = new THREE.CatmullRomCurve3(LAYOUT.map(p => new THREE.Vector3(p[0], p[2], p[1])), true, 'centripetal');
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
    // smooth the heights so ramps feel gentle
    const ys = this.P.map(p => p.y);
    for (let pass = 0; pass < 6; pass++) for (let i = 0; i < N; i++) ys[i] = (ys[(i - 2 + N) % N] + ys[(i - 1 + N) % N] + ys[i] * 2 + ys[(i + 1) % N] + ys[(i + 2) % N]) / 6;
    this.P.forEach((p, i) => p.y = ys[i]);
    // where the road is a bridge (over the canyon) or in the tunnel
    this.kind = this.P.map(p => Math.hypot(p.x - MOUNTAIN.x, p.z - MOUNTAIN.z) < TUNNEL_R ? 'tunnel' : canyonDist(p.x, p.z) < CANYON_HALF + 4 ? 'bridge' : 'ground');
    // turn rate at each sample, for the AI (how sharp the road bends ahead)
    this.bend = this.T.map((t, i) => { const u = this.T[(i + 12) % N]; return Math.atan2(t.x * u.z - t.z * u.x, t.x * u.x + t.z * u.z); });
    // a coarse grid of samples for fast "nearest road" lookups when building the terrain
    this.cell = 40; this.buckets = new Map();
    this.P.forEach((p, i) => { const k = Math.floor(p.x / this.cell) + ',' + Math.floor(p.z / this.cell); if (!this.buckets.has(k)) this.buckets.set(k, []); this.buckets.get(k).push(i); });
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

  /* ---------- terrain height ---------- */
  // raw ground: rolling dunes (calm near the road), the mountain, the canyon and the far ridges
  rawHeight(x, z, dTrack){
    const calm = sstep(16, 90, dTrack);
    let h = (noise(x * .007, z * .007) * 12 + noise(x * .025, z * .025) * 3) * calm;
    const dm = Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z);
    if (dm < MOUNTAIN.r) h += MOUNTAIN.h * (.5 + .5 * Math.cos(Math.PI * dm / MOUNTAIN.r)) * (.85 + .25 * noise(x * .03, z * .03));
    const de = Math.hypot(x - WORLD.cx, z - WORLD.cz);
    h += sstep(560, 900, de) * (70 + 50 * noise(x * .004, z * .004));
    const dc = canyonDist(x, z);
    if (dc < CANYON_HALF) h += (CANYON_DEPTH - h) * sstep(CANYON_HALF, CANYON_FLOOR, dc) + noise(x * .08, z * .08) * 1.5 * sstep(CANYON_HALF, CANYON_FLOOR, dc);
    return h;
  }
  height(x, z){
    const n = this.near(x, z, 2), d = n.d;
    let h = this.rawHeight(x, z, d);
    // the ground meets the road level next to it (not under the bridge or over the tunnel)
    if (n.i >= 0 && this.kind[n.i] === 'ground'){ const w = sstep(HALF_W + 24, HALF_W + 4, d); h += (this.P[n.i].y - .3 - h) * w; }
    // inside the tunnel slot the ground drops to the road, so cells at the portals don't rise across the road
    else if (n.i >= 0 && this.kind[n.i] === 'tunnel' && d < HALF_W + 6) h = this.P[n.i].y - .3;
    return h;
  }
  inSlot(x, z){ const n = this.near(x, z, 1); return n.i >= 0 && n.d < HALF_W + 9 && this.kind[n.i] === 'tunnel'; }

  /* ---------- the scene ---------- */
  build(scene, quality){
    const rng = mulberry(11);
    const root = new THREE.Group(); scene.add(root); this.root = root;
    this.buildSky(root, rng);
    this.buildTerrain(root, quality);
    this.buildRiver(root);
    this.buildRoad(root);
    this.buildRails(root);
    this.buildBridge(root);
    this.buildTunnel(root);
    this.buildStart(root);
    this.buildScenery(root, rng, quality);
  }

  buildSky(root, rng){
    const skyG = new THREE.SphereGeometry(1500, 32, 20), cols = [];
    const top = new THREE.Color('#161040'), mid = new THREE.Color('#6b2c78'), hor = new THREE.Color('#ff9a5c'), low = new THREE.Color('#ffc58a');
    const pa = skyG.attributes.position;
    for (let i = 0; i < pa.count; i++){
      const h = pa.getY(i) / 1500, c = h < 0 ? low.clone() : h < .12 ? low.clone().lerp(hor, h / .12) : h < .4 ? hor.clone().lerp(mid, (h - .12) / .28) : mid.clone().lerp(top, (h - .4) / .6);
      cols.push(c.r, c.g, c.b);
    }
    skyG.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    root.add(new THREE.Mesh(skyG, new THREE.MeshBasicMaterial({ vertexColors:true, side:THREE.BackSide, fog:false, depthWrite:false })));
    // the setting sun with a soft halo, in the direction of the sunlight
    this.sunDir = new THREE.Vector3(-.75, .16, -.64).normalize();
    const sun = new THREE.Mesh(new THREE.CircleGeometry(70, 40), new THREE.MeshBasicMaterial({ color:'#ffe2a0', fog:false }));
    sun.position.copy(this.sunDir).multiplyScalar(1350); sun.lookAt(0, 0, 0); root.add(sun);
    const haloTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const r = g.createRadialGradient(64, 64, 10, 64, 64, 64);
      r.addColorStop(0, 'rgba(255,220,150,.9)'); r.addColorStop(.35, 'rgba(255,150,90,.35)'); r.addColorStop(1, 'rgba(255,120,80,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ map:haloTex, transparent:true, depthWrite:false, fog:false, blending:THREE.AdditiveBlending }));
    halo.position.copy(this.sunDir).multiplyScalar(1340); halo.lookAt(0, 0, 0); root.add(halo);
    // thin streaky clouds catching the light
    for (let i = 0; i < 14; i++){
      const c = new THREE.Mesh(new THREE.PlaneGeometry(260 + rng() * 300, 14 + rng() * 16), new THREE.MeshBasicMaterial({ color:rng() < .5 ? '#ffb38a' : '#d97aa6', transparent:true, opacity:.55, fog:false, depthWrite:false, side:THREE.DoubleSide }));
      const a = rng() * Math.PI * 2, d = 1100; c.position.set(Math.cos(a) * d, 220 + rng() * 260, Math.sin(a) * d); c.lookAt(0, c.position.y * .6, 0); root.add(c);
    }
  }

  buildTerrain(root, quality){
    const S = WORLD.size, n = quality === 'low' ? 200 : 300, step = S / n, x0 = WORLD.cx - S / 2, z0 = WORLD.cz - S / 2;
    const pos = new Float32Array((n + 1) * (n + 1) * 3), col = new Float32Array((n + 1) * (n + 1) * 3), H = new Float32Array((n + 1) * (n + 1));
    const sand = new THREE.Color('#e3a064'), sand2 = new THREE.Color('#d58a52'), rockA = new THREE.Color(COLORS.rock), rockB = new THREE.Color(COLORS.rock2), rockC = new THREE.Color(COLORS.rock3), grass = new THREE.Color('#7d8f4a'), c = new THREE.Color();
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++){
      const x = x0 + i * step, z = z0 + j * step, h = this.height(x, z), k = j * (n + 1) + i;
      H[k] = h; pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      // colour by height: banded rock in the canyon and on the mountain, sand elsewhere, a green river floor
      if (h < CANYON_DEPTH + 3) c.copy(grass);
      else if (h < -3) c.copy([rockA, rockB, rockC][Math.floor(-h / 5) % 3]);
      else if (h > 18) c.copy([rockA, rockB, rockC][Math.floor(h / 9) % 3]).lerp(new THREE.Color('#f0d0b0'), sstep(70, 100, h) * .6);
      else c.copy(sand).lerp(sand2, (noise(x * .05, z * .05) + 1) / 2);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    const idx = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++){
      const a = j * (n + 1) + i, b = a + 1, d = a + n + 1, e = d + 1;
      // leave a slot where the road runs through the mountain: the tunnel fills it
      if (this.inSlot(x0 + (i + .5) * step, z0 + (j + .5) * step)) continue;
      idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    root.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors:true, flatShading:true, roughness:.95, metalness:0 })));
  }

  buildRiver(root){
    // a ribbon of water along the canyon floor
    const pts = CANYON.map(([x, z]) => new THREE.Vector3(x, CANYON_DEPTH + 2.2, z)), curve = new THREE.CatmullRomCurve3(pts);
    const M = 200, pos = [], idx = [];
    for (let i = 0; i <= M; i++){
      const p = curve.getPointAt(i / M), t = curve.getTangentAt(i / M), r = new THREE.Vector3(-t.z, 0, t.x).normalize(), w = CANYON_FLOOR + 3;
      pos.push(p.x + r.x * w, p.y, p.z + r.z * w, p.x - r.x * w, p.y, p.z - r.z * w);
      if (i < M){ const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    root.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color:'#2a9fc4', roughness:.15, metalness:.2, side:THREE.DoubleSide, emissive:new THREE.Color('#0b3a55'), emissiveIntensity:.6 })));
  }

  buildRoad(root){
    const N = this.N, pos = [], uv = [], idx = [], cpos = [], ccol = [], cidx = [];
    let dist = 0;
    const red = new THREE.Color('#ff2e4a'), wht = new THREE.Color('#ffffff');
    for (let i = 0; i <= N; i++){
      const k = i % N, p = this.P[k], r = this.R[k];
      if (i) dist += SPACING;
      for (const s of [-1, 1]){ pos.push(p.x + r.x * HALF_W * s, p.y + .06, p.z + r.z * HALF_W * s); uv.push(s < 0 ? 0 : 1, dist / 24); }
      // kerbs just inside the rails
      const c = Math.floor(dist / 3) % 2 ? red : wht;
      for (const s of [-1, 1]) for (const w of [HALF_W - 1, HALF_W]){ cpos.push(p.x + r.x * w * s, p.y + .1, p.z + r.z * w * s); ccol.push(c.r, c.g, c.b); }
      if (i < N){ const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        const b = i * 4; cidx.push(b, b + 4, b + 1, b + 1, b + 4, b + 5, b + 2, b + 3, b + 6, b + 3, b + 7, b + 6); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    root.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map:this.roadTexture(), roughness:.85, metalness:0, side:THREE.DoubleSide })));
    const kg = new THREE.BufferGeometry();
    kg.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3)); kg.setAttribute('color', new THREE.Float32BufferAttribute(ccol, 3)); kg.setIndex(cidx); kg.computeVertexNormals();
    root.add(new THREE.Mesh(kg, new THREE.MeshStandardMaterial({ vertexColors:true, roughness:.7, side:THREE.DoubleSide })));
  }

  // guard rails: posts, a steel beam and a neon strip (one instanced mesh each); none in the tunnel
  buildRails(root){
    const N = this.N, L = 4, step = Math.round(L / SPACING), count = Math.ceil(N / step) * 2;
    const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(COLORS.steel, { roughness:.35, metalness:.7 }), count);
    const neon = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), glow('#ffffff'), count);
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(.25, 1, .25), mat(COLORS.dark, { metalness:.5 }), count);
    const cyan = new THREE.Color(COLORS.cyan), mag = new THREE.Color(COLORS.magenta);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i + step <= N; i += step){
      if (this.kind[i] === 'tunnel' || this.kind[(i + step) % N] === 'tunnel') continue;
      const a = this.P[i], b = this.P[(i + step) % N];
      for (const side of [-1, 1]){
        const ra = this.R[i], rb = this.R[(i + step) % N], o = HALF_W + .6;
        const ax = a.x + ra.x * o * side, az = a.z + ra.z * o * side, bx = b.x + rb.x * o * side, bz = b.z + rb.z * o * side, ay = a.y, by = b.y;
        const len = Math.hypot(bx - ax, bz - az) + .1, y = (ay + by) / 2;
        e.set(-Math.atan2(by - ay, len), Math.atan2(bx - ax, bz - az), 0, 'YXZ'); q.setFromEuler(e);
        p.set((ax + bx) / 2, y + .75, (az + bz) / 2); s.set(.18, .45, len); m.compose(p, q, s); beams.setMatrixAt(n, m);
        p.set((ax + bx) / 2, y + 1.02, (az + bz) / 2); s.set(.12, .08, len); m.compose(p, q, s); neon.setMatrixAt(n, m); neon.setColorAt(n, side > 0 ? cyan : mag);
        p.set(ax, ay + .5, az); s.set(1, 1, 1); e.set(0, 0, 0); m.compose(p, new THREE.Quaternion(), s); posts.setMatrixAt(n, m);
        n++;
      }
    }
    beams.count = neon.count = posts.count = n; root.add(beams, neon, posts);
  }

  // a steel tied-arch bridge over the canyon, on concrete piers
  buildBridge(root){
    const N = this.N, idx = []; for (let i = 0; i < N; i++) if (this.kind[i] === 'bridge') idx.push(i);
    if (!idx.length) return;
    const i0 = idx[0], i1 = idx[idx.length - 1], span = i1 - i0;
    // deck sides and underside, the whole length of the raised road
    const ug = [], ui = [];
    for (let k = 0; k <= span; k++){ const p = this.P[i0 + k], r = this.R[i0 + k];
      for (const s of [-1, 1]) ug.push(p.x + r.x * (HALF_W + .9) * s, p.y + .05, p.z + r.z * (HALF_W + .9) * s, p.x + r.x * (HALF_W + .9) * s, p.y - 2.4, p.z + r.z * (HALF_W + .9) * s);
      if (k < span){ const a = k * 4; ui.push(a, a + 1, a + 4, a + 1, a + 5, a + 4, a + 2, a + 6, a + 3, a + 3, a + 6, a + 7, a + 1, a + 3, a + 5, a + 3, a + 7, a + 5); } }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(ug, 3)); sg.setIndex(ui); sg.computeVertexNormals();
    root.add(new THREE.Mesh(sg, mat('#5b6070', { side:THREE.DoubleSide, roughness:.6, metalness:.3 })));
    // the two arches with hangers
    const steel = mat('#d8462f', { roughness:.4, metalness:.5 }), rise = 24;
    for (const s of [-1, 1]){
      const pts = [];
      for (let k = 0; k <= 24; k++){ const i = i0 + Math.round(span * k / 24), p = this.P[i], r = this.R[i]; pts.push(new THREE.Vector3(p.x + r.x * (HALF_W + 1.4) * s, p.y + .5 + Math.sin(Math.PI * k / 24) * rise, p.z + r.z * (HALF_W + 1.4) * s)); }
      root.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, .9, 6), steel));
      for (let k = 2; k < 24; k += 2){ const i = i0 + Math.round(span * k / 24), p = this.P[i], r = this.R[i], h = Math.sin(Math.PI * k / 24) * rise;
        const c = part(new THREE.CylinderGeometry(.12, .12, h, 5), mat('#e9e9ee', { metalness:.6, roughness:.3 }), p.x + r.x * (HALF_W + 1.4) * s, p.y + .5 + h / 2, p.z + r.z * (HALF_W + 1.4) * s); root.add(c); }
      // neon line along the arch
      root.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(v => v.clone().add(new THREE.Vector3(0, .95, 0)))), 60, .12, 4), glow('#ffb347')));
    }
    // piers down to the canyon floor
    for (const f of [0, .25, .5, .75, 1]){ const i = i0 + Math.round(span * f), p = this.P[i], base = this.height(p.x, p.z);
      if (p.y - base < 3) continue;
      const h = p.y - 2.4 - base + 2; root.add(part(new THREE.CylinderGeometry(2.4, 3.2, h, 8), mat('#9aa0ad', { roughness:.8 }), p.x, base - 2 + h / 2, p.z)); }
  }

  // the tunnel: an arched tube through the mountain with ceiling lights and neon wall strips
  buildTunnel(root){
    const N = this.N, idx = []; for (let i = 0; i < N; i++) if (this.kind[i] === 'tunnel') idx.push(i);
    if (!idx.length) return;
    const i0 = idx[0] - 2, i1 = idx[idx.length - 1] + 2, span = i1 - i0, R = HALF_W + 3, M = 18;
    const pos = [], ind = [];
    for (let k = 0; k <= span; k++){
      const i = this.wrap(i0 + k), p = this.P[i], r = this.R[i];
      // cross-section: straight walls up to 3, then a half-circle roof
      const ring = [[-R, -.5], [-R, 3]];
      for (let a = 1; a < M; a++){ const t = Math.PI - Math.PI * a / M; ring.push([Math.cos(t) * R, 3 + Math.sin(t) * R * .8]); }
      ring.push([R, 3], [R, -.5]);
      for (const [sx, sy] of ring) pos.push(p.x + r.x * sx, p.y + sy, p.z + r.z * sx);
      if (k < span){ const L = ring.length, a = k * L; for (let j = 0; j < L - 1; j++) ind.push(a + j, a + L + j, a + j + 1, a + j + 1, a + L + j, a + L + j + 1); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(ind); g.computeVertexNormals();
    root.add(new THREE.Mesh(g, mat('#3b3f4c', { side:THREE.DoubleSide, roughness:.9 })));
    // lights: warm panels on the ceiling, cyan and magenta strips on the walls
    const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(3, .2, 1.2), glow('#ffe1a8'), Math.ceil(span / 8) + 1);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3(); let n = 0;
    for (let k = 0; k <= span; k += 8){ const i = this.wrap(i0 + k), p = this.P[i]; q.setFromEuler(new THREE.Euler(0, this.heading(i), 0)); v.set(p.x, p.y + 3 + R * .8 - .3, p.z); m.compose(v, q, s); lamps.setMatrixAt(n++, m); }
    lamps.count = n; root.add(lamps);
    for (const side of [-1, 1]){
      const sp = [], si = [];
      for (let k = 0; k <= span; k++){ const i = this.wrap(i0 + k), p = this.P[i], r = this.R[i], x = (R - .05) * side;
        sp.push(p.x + r.x * x, p.y + 1.6, p.z + r.z * x, p.x + r.x * x, p.y + 1.9, p.z + r.z * x);
        if (k < span){ const a = k * 2; si.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } }
      const sgeo = new THREE.BufferGeometry(); sgeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sgeo.setIndex(si);
      root.add(new THREE.Mesh(sgeo, glow(side > 0 ? COLORS.cyan : COLORS.magenta, { side:THREE.DoubleSide })));
    }
    // portals: a rock face around a concrete arch at each end
    for (const [k, dir] of [[0, -1], [span, 1]]){
      const i = this.wrap(i0 + k), p = this.P[i], h = this.heading(i);
      // shapes go around the opening (a hole touching the edge breaks the triangulation)
      const opening = (sh, r) => { sh.lineTo(-r, -2); sh.lineTo(-r, 3); sh.absarc(0, 3, r, Math.PI, 0, true); sh.lineTo(r, -2); };
      const W = R + 12, face = new THREE.Shape(); face.moveTo(-W, -2); opening(face, R);
      for (const [fx, fy] of [[W, -2], [W * .9, 9], [W * .6, 19], [W * .25, 24], [-W * .2, 23], [-W * .55, 18], [-W * .85, 10]]) face.lineTo(fx, fy);
      face.closePath();
      const fm = new THREE.Mesh(new THREE.ExtrudeGeometry(face, { depth:4, bevelEnabled:false }), mat(COLORS.rock)); fm.position.set(p.x, p.y, p.z); fm.rotation.y = h; fm.translateZ(-2); root.add(fm);
      const arch = new THREE.Shape(); arch.moveTo(-R - 1.5, -2); opening(arch, R); arch.lineTo(R + 1.5, -2); arch.lineTo(R + 1.5, 3); arch.absarc(0, 3, R + 1.5, 0, Math.PI, false); arch.closePath();
      const am = new THREE.Mesh(new THREE.ExtrudeGeometry(arch, { depth:5, bevelEnabled:false }), mat('#a8adb8', { roughness:.7 })); am.position.set(p.x, p.y, p.z); am.rotation.y = h; am.translateZ(-2.5); root.add(am);
      // a neon outline on the arch
      const curve = new THREE.CurvePath(); const pts = []; for (let a = 0; a <= 24; a++){ const t = Math.PI - Math.PI * a / 24; pts.push(new THREE.Vector3(Math.cos(t) * (R + .8), 3 + Math.sin(t) * (R + .8), 0)); }
      const neon = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, .18, 5), glow(COLORS.cyan)); neon.position.set(p.x, p.y, p.z); neon.rotation.y = h; neon.translateZ(dir > 0 ? 2.6 : -2.6); root.add(neon);
    }
  }

  buildStart(root){
    const s0 = 4, p0 = this.P[s0], h0 = this.heading(s0);
    const g = new THREE.Group(); g.position.copy(p0); g.rotation.y = h0; root.add(g);
    const dark = mat('#20222c', { metalness:.6, roughness:.35 });
    for (const s of [-1, 1]){ const leg = part(new THREE.BoxGeometry(1.4, 11, 1.4), dark, s * (HALF_W + 2), 5.5, 0); leg.rotation.z = s * .08; g.add(leg);
      g.add(part(new THREE.BoxGeometry(.2, 10, .2), glow(s > 0 ? COLORS.cyan : COLORS.magenta), s * (HALF_W + 1.25), 5.5, .75)); }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 6, 3, 1), [dark, dark, dark, dark, glow('#ffffff', { map:this.bannerTexture() }), glow('#ffffff', { map:this.bannerTexture() })]);
    banner.position.y = 10.5; g.add(banner);
    // start lights
    this.startLights = [];
    for (let i = 0; i < 5; i++){ const l = part(new THREE.CylinderGeometry(.45, .45, .3, 14), glow('#40141a'), (i - 2) * 1.4, 8.4, -.6); l.rotation.x = Math.PI / 2; g.add(l); this.startLights.push(l); }
    // chequered line
    const chk = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, 3).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map:this.checkerTexture(), roughness:.8 }));
    chk.position.copy(p0); chk.position.y += .09; chk.rotation.y = h0; root.add(chk);
    // grandstand on the outside of the start straight
    const gs = new THREE.Group(), side = -1, i = this.wrap(s0 - 30), p = this.P[i], r = this.R[i];
    gs.position.set(p.x + r.x * (HALF_W + 16) * side, p.y, p.z + r.z * (HALF_W + 16) * side); gs.rotation.y = this.heading(i) + Math.PI / 2 * side; root.add(gs);
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(.7, .9, .6), mat('#ffffff'), 6 * 40), rng = mulberry(5), m4 = new THREE.Matrix4(), cc = new THREE.Color();
    let n = 0;
    for (let t = 0; t < 6; t++){ gs.add(part(new THREE.BoxGeometry(60, 1.2, 3), mat('#3a3e4c'), 0, t * 1.2 + .6, t * 3));
      for (let c = 0; c < 40; c++){ if (rng() < .25) continue; m4.makeTranslation(-28 + c * 1.45, t * 1.2 + 1.65, t * 3); crowd.setMatrixAt(n, m4); crowd.setColorAt(n, cc.setHSL(rng(), .7, .55)); n++; } }
    crowd.count = n; gs.add(crowd);
    gs.add(part(new THREE.BoxGeometry(62, .4, 20), mat('#20222c'), 0, 12, 8));
    gs.add(part(new THREE.BoxGeometry(62, .2, .3), glow(COLORS.cyan), 0, 11.7, -1.8));
  }

  buildScenery(root, rng, quality){
    const far = (x, z, m) => this.near(x, z, 3).d > HALF_W + m;
    const place = (make, count, margin, test, yoff = 0) => { let n = 0, tries = 0;
      while (n < count && tries++ < count * 40){
        const x = WORLD.cx - 700 + rng() * 1400, z = WORLD.cz - 700 + rng() * 1400, h = this.height(x, z);
        if (!far(x, z, margin) || (test && !test(x, z, h))) continue;
        const o = make(rng); o.position.set(x, h + yoff, z); root.add(o); n++; } };
    const lots = quality === 'low' ? .5 : 1;
    const flat = (x, z, h) => h > -2 && h < 16 && Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z) > MOUNTAIN.r * .8;
    place(mesa, 14, 70, (x, z, h) => flat(x, z, h) && canyonDist(x, z) > 90, -2);
    place(r => rock(r, 1.4), 120 * lots, 6, flat);
    place(shrub, 180 * lots, 5, flat);
    place(cactus, 70 * lots, 6, flat);
    place(pine, 90 * lots, 8, (x, z, h) => h > 8 && h < 60 || h < CANYON_DEPTH + 4);
    // light pylons and billboards along the road
    for (let i = 20, s = 1; i < this.N; i += 70, s = -s){
      if (this.kind[i] !== 'ground') continue;
      const p = this.pos(i, s * (HALF_W + 4)), py = pylon(s > 0 ? COLORS.cyan : COLORS.magenta); py.position.copy(p); py.rotation.y = this.heading(i); root.add(py);
    }
    const tex = this.billboardTexture();
    for (const f of [.18, .42, .66, .9]){
      const i = Math.round(this.N * f); if (this.kind[i] !== 'ground') continue;
      const s = f > .5 ? 1 : -1, p = this.pos(i, s * (HALF_W + 9)), b = new THREE.Group(); b.position.copy(p); b.rotation.y = this.heading(i) - s * Math.PI / 2; root.add(b);
      for (const x of [-5, 5]) b.add(part(new THREE.BoxGeometry(.5, 7, .5), mat(COLORS.dark), x, 3.5, 0));
      b.add(part(new THREE.BoxGeometry(13, 5, .4), mat(COLORS.dark), 0, 8, 0));
      const face = new THREE.Mesh(new THREE.PlaneGeometry(12.4, 4.4), glow('#ffffff', { map:tex })); face.position.set(0, 8, .21); b.add(face);
    }
  }

  /* ---------- canvas textures ---------- */
  canvas(w, h, draw){ const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }
  roadTexture(){
    const t = this.canvas(256, 256, (g, w, h) => {
      g.fillStyle = '#34363f'; g.fillRect(0, 0, w, h);
      const r = mulberry(3); for (let i = 0; i < 1400; i++){ g.fillStyle = r() < .5 ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.06)'; g.fillRect(r() * w, r() * h, 2, 2); }
      g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(16, 0, 5, h); g.fillRect(w - 21, 0, 5, h);
      g.fillStyle = 'rgba(255,214,90,.9)'; g.fillRect(w * .5 - 3, 0, 6, h * .45);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  checkerTexture(){
    return this.canvas(256, 64, (g, w, h) => { const n = 12; for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++){ g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(i * w / n, j * h / 3, w / n + 1, h / 3 + 1); } });
  }
  bannerTexture(){
    return this.canvas(1024, 128, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#12081f'); gr.addColorStop(.5, '#1d0f33'); gr.addColorStop(1, '#12081f');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.font = 'italic 900 86px "Russo One", "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = '#3ff6ff'; g.shadowBlur = 24; g.fillStyle = '#ffffff'; g.fillText('TEKRACERS', w / 2, h / 2 + 4);
      g.shadowBlur = 0; g.fillStyle = '#ff3df2'; g.fillRect(0, h - 8, w, 8); g.fillStyle = '#3ff6ff'; g.fillRect(0, 0, w, 8);
    });
  }
  billboardTexture(){
    return this.canvas(512, 180, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#ff3df2'); gr.addColorStop(1, '#3a1cff'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.font = 'italic 900 70px "Russo One", "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText('TEKRAMOS', w / 2, h / 2 - 12);
      g.font = '700 26px "Exo 2", sans-serif'; g.fillText('www.tekramos.com', w / 2, h / 2 + 46);
    });
  }
}

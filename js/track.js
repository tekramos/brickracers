/* ============================================================
   The track: a closed spline sampled into evenly spaced points. Karts, bricks and the AI all
   work in track coordinates (sample index + sideways offset). The scene is a brick island:
   a studded green baseplate in a cartoon sea, brick walls on both sides of the road, a
   bridge over a river, palms, huts and a start gantry.
   ============================================================ */
import * as THREE from 'three';
import { toon, basic, part, outline, studs, tree, palm, house, rock, cloud, flag, COLORS } from './models.js';

// control points: x, z, height
const LAYOUT = [
  [0, 0, 0], [55, 0, 0], [105, -8, 0], [138, -42, 0], [140, -88, 1], [112, -122, 5], [62, -132, 7], [14, -126, 5],
  [-24, -146, 1], [-70, -168, 0], [-118, -150, 0], [-136, -106, 0], [-108, -78, 0], [-132, -46, 0], [-118, -8, 0], [-76, 10, 0], [-38, 4, 0],
];
const SCALE = 1.35;         // stretch the layout to set the lap length
export const ISLAND = { x:-2, z:-105, r:300 };
export const HALF_W = 9;     // half the road width
const SPACING = 1;           // distance between samples

export function mulberry(seed){ return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export class Track {
  constructor(){
    const curve = new THREE.CatmullRomCurve3(LAYOUT.map(p => new THREE.Vector3(p[0] * SCALE, p[2], p[1] * SCALE)), true, 'centripetal');
    this.length = curve.getLength();
    const N = this.N = Math.round(this.length / SPACING);
    const pts = curve.getSpacedPoints(N);
    this.P = []; this.T = []; this.R = [];
    for (let i = 0; i < N; i++){
      const p = pts[i], q = pts[(i + 1) % N];
      const t = new THREE.Vector3().subVectors(q, p).normalize();
      // sideways vector (to the right when facing along the track), kept level
      const r = new THREE.Vector3(-t.z, 0, t.x).normalize();
      this.P.push(p); this.T.push(t); this.R.push(r);
    }
    // smooth the heights a little so ramps feel gentle
    const ys = this.P.map(p => p.y);
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < N; i++) ys[i] = (ys[(i - 2 + N) % N] + ys[(i - 1 + N) % N] + ys[i] * 2 + ys[(i + 1) % N] + ys[(i + 2) % N]) / 6;
    this.P.forEach((p, i) => p.y = ys[i]);
    // turn rate at each sample, for the AI (how sharp the road bends ahead)
    this.bend = this.T.map((t, i) => { const u = this.T[(i + 12) % N]; return Math.atan2(t.x * u.z - t.z * u.x, t.x * u.x + t.z * u.z); });
  }
  wrap(i){ const N = this.N; return ((i % N) + N) % N; }
  // nearest sample to (x, z), searching around a hint index (karts move only a few samples a frame)
  nearest(x, z, hint, range = 40){
    let best = hint, bd = Infinity;
    if (hint == null || hint < 0){ hint = 0; range = this.N >> 1; }
    for (let k = -range; k <= range; k++){
      const i = this.wrap(hint + k), p = this.P[i], d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd){ bd = d; best = i; }
    }
    return best;
  }
  // where (x, z) sits on the road: index, sideways offset, fractional progress and height
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

  /* ---------- the scene ---------- */
  build(scene, quality){
    const N = this.N, rng = mulberry(7);
    const root = new THREE.Group(); scene.add(root); this.root = root;

    // sky dome with a vertical gradient
    const skyG = new THREE.SphereGeometry(900, 32, 16), cols = [], top = new THREE.Color('#3a7bea'), hor = new THREE.Color('#bfe6ff');
    const pa = skyG.attributes.position;
    for (let i = 0; i < pa.count; i++){ const h = Math.max(0, pa.getY(i) / 900); const c = hor.clone().lerp(top, Math.pow(h, .6)); cols.push(c.r, c.g, c.b); }
    skyG.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    root.add(new THREE.Mesh(skyG, new THREE.MeshBasicMaterial({ vertexColors:true, side:THREE.BackSide, fog:false, depthWrite:false })));
    for (let i = 0; i < 16; i++){ const c = cloud(rng); const a = rng() * Math.PI * 2, d = 380 + rng() * 260; c.position.set(Math.cos(a) * d, 70 + rng() * 60, Math.sin(a) * d); c.scale.setScalar(1.5 + rng() * 1.5); root.add(c); }

    // sea and the island baseplate
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), toon('#2b9be0')); sea.position.y = -1.2; root.add(sea);
    this.seaRings = [];
    const plate = this.studTexture();
    const IR = ISLAND.r, shape = k => { const sh = new THREE.Shape();
      for (let i = 0; i <= 64; i++){ const a = i / 64 * Math.PI * 2, r = k * IR * (1 + .08 * Math.sin(a * 3) + .05 * Math.sin(a * 7 + 1)); const x = Math.cos(a) * r + ISLAND.x, z = Math.sin(a) * r + ISLAND.z; i ? sh.lineTo(x, z) : sh.moveTo(x, z); }
      return sh; };
    const isl = new THREE.Mesh(new THREE.ExtrudeGeometry(shape(1), { depth:2, bevelEnabled:false, curveSegments:4 }).rotateX(Math.PI / 2), [toon('#6bd04a', { map:plate }), toon('#e8c88a')]);
    root.add(isl);
    // sandy beach ring just below the baseplate
    const beach = new THREE.Mesh(new THREE.ShapeGeometry(shape(1.06), 4).rotateX(Math.PI / 2), toon('#f1d79a', { side:THREE.DoubleSide })); beach.position.y = -.7; root.add(beach);
    // a river crossing under the bridge
    const riv = new THREE.Mesh(new THREE.PlaneGeometry(26, 700).rotateX(-Math.PI / 2), toon('#2b9be0')); riv.position.set(89, .04, -176); riv.rotation.y = .25; root.add(riv);

    this.buildRoad(root, quality);
    this.buildWalls(root);

    // start gantry
    const g = new THREE.Group(), s0 = 4;
    const p0 = this.P[s0], h0 = this.heading(s0);
    g.position.copy(p0); g.rotation.y = h0; root.add(g);
    for (const s of [-1, 1]){ g.add(part(new THREE.BoxGeometry(1.6, 9, 1.6), COLORS.red, s * (HALF_W + 1.6), 4.5, 0, .08)); studs(g, COLORS.red, 2, 2, 9, s * (HALF_W + 1.6), 0); }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 5, 2.4, .8), [toon(COLORS.yellow), toon(COLORS.yellow), toon(COLORS.yellow), toon(COLORS.yellow), toon('#ffffff', { map:this.bannerTexture() }), toon('#ffffff', { map:this.bannerTexture() })]);
    banner.position.y = 8.2; outline(banner, .08); g.add(banner);
    // chequered line on the road
    const chk = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, 3).rotateX(-Math.PI / 2), toon('#ffffff', { map:this.checkerTexture() }));
    chk.position.copy(p0); chk.position.y += .09; chk.rotation.y = h0; root.add(chk);

    // scenery away from the road
    const far = (x, z, m) => { const i = this.nearest(x, z, -1); const p = this.P[i]; return Math.hypot(p.x - x, p.z - z) > HALF_W + m; };
    const onIsland = (x, z) => Math.hypot(x - ISLAND.x, z - ISLAND.z) < ISLAND.r * .86 - 12;
    const inRiver = (x, z) => { const dx = x - 89, dz = z + 176, c = Math.cos(.25), s = Math.sin(.25); const lx = dx * c - dz * s; return Math.abs(lx) < 16; };
    const place = (make, count, margin, scale = 1) => { let n = 0, tries = 0;
      while (n < count && tries++ < count * 30){ const x = ISLAND.x - ISLAND.r + rng() * ISLAND.r * 2, z = ISLAND.z - ISLAND.r + rng() * ISLAND.r * 2;
        if (!onIsland(x, z) || inRiver(x, z) || !far(x, z, margin)) continue;
        const o = make(rng); o.position.set(x, 0, z); o.rotation.y = rng() * Math.PI * 2; o.scale.multiplyScalar(scale); root.add(o); n++; } };
    const lots = quality === 'low' ? .5 : 1;
    place(palm, 70 * lots, 5);
    place(tree, 55 * lots, 6);
    place(rock, 40 * lots, 4);
    place(r => house(r, [COLORS.white, COLORS.yellow, '#ffe9b0', COLORS.tan][r() * 4 | 0], [COLORS.red, COLORS.blue, COLORS.green][r() * 3 | 0]), 9, 14);
    // flags along the start straight
    this.flags = [];
    for (let i = 0; i < 6; i++){ for (const s of [-1, 1]){ const k = this.wrap(-30 + i * 14), f = flag([COLORS.red, COLORS.yellow, COLORS.blue, COLORS.green][(i + (s > 0)) % 4]); this.pos(k, s * (HALF_W + 3), f.position); f.rotation.y = this.heading(k) + (s > 0 ? 0 : Math.PI); root.add(f); this.flags.push(f); } }
    // a lighthouse on the shore for a landmark
    const lh = new THREE.Group(); lh.position.set(215, 0, 40); root.add(lh);
    for (let i = 0; i < 6; i++) lh.add(part(new THREE.CylinderGeometry(3.2 - i * .3, 3.4 - i * .3, 3, 14), i % 2 ? COLORS.white : COLORS.red, 0, 1.5 + i * 3, 0, .08));
    lh.add(part(new THREE.CylinderGeometry(1.6, 1.6, 2, 10), '#fff36b', 0, 19, 0, .06), part(new THREE.ConeGeometry(2.4, 2.4, 10), COLORS.red, 0, 21.2, 0, .08));
  }

  buildRoad(root){
    const N = this.N, pos = [], uv = [], idx = [], cpos = [], ccol = [], cidx = [];
    let dist = 0;
    const red = new THREE.Color(COLORS.red), wht = new THREE.Color('#ffffff');
    for (let i = 0; i <= N; i++){
      const k = i % N, p = this.P[k], r = this.R[k];
      if (i) dist += SPACING;
      for (const s of [-1, 1]){ pos.push(p.x + r.x * HALF_W * s, p.y + .06, p.z + r.z * HALF_W * s); uv.push(s < 0 ? 0 : 1, dist / 18); }
      // kerbs: thin raised strips just inside the walls, red and white blocks
      const c = Math.floor(dist / 3) % 2 ? red : wht;
      for (const s of [-1, 1]) for (const w of [HALF_W - 1.1, HALF_W]){ cpos.push(p.x + r.x * w * s, p.y + .1, p.z + r.z * w * s); ccol.push(c.r, c.g, c.b); }
      if (i < N){ const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        const b = i * 4; cidx.push(b, b + 4, b + 1, b + 1, b + 4, b + 5, b + 2, b + 3, b + 6, b + 3, b + 7, b + 6); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const road = new THREE.Mesh(g, toon('#ffffff', { map:this.roadTexture(), side:THREE.DoubleSide })); root.add(road);
    const kg = new THREE.BufferGeometry();
    kg.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3)); kg.setAttribute('color', new THREE.Float32BufferAttribute(ccol, 3)); kg.setIndex(cidx); kg.computeVertexNormals();
    root.add(new THREE.Mesh(kg, new THREE.MeshToonMaterial({ vertexColors:true, side:THREE.DoubleSide })));
    // the bridge deck sides and pillars where the road is raised
    const deck = [];
    for (let i = 0; i < N; i += 1){ const p = this.P[i]; if (p.y > .6) deck.push(i); }
    const pil = new THREE.CylinderGeometry(1.2, 1.4, 1, 10), col = toon(COLORS.gray);
    for (let n = 0; n < deck.length; n += 10){ const i = deck[n], p = this.P[i], r = this.R[i];
      for (const s of [-1, 1]){ const m = new THREE.Mesh(pil, col), h = p.y + 1.1; m.scale.y = h; m.position.set(p.x + r.x * (HALF_W - 1.5) * s, -1.5 + h / 2, p.z + r.z * (HALF_W - 1.5) * s); outline(m, .06); root.add(m); } }
    // underside of the raised deck so it looks solid from the side
    const ug = [], ui = []; let v = 0;
    for (let i = 0; i <= N; i++){ const k = i % N, p = this.P[k], r = this.R[k];
      for (const s of [-1, 1]){ ug.push(p.x + r.x * HALF_W * s, p.y + .05, p.z + r.z * HALF_W * s, p.x + r.x * HALF_W * s, p.y - 1.2, p.z + r.z * HALF_W * s); }
      if (i < N){ const a = i * 4; ui.push(a, a + 1, a + 4, a + 1, a + 5, a + 4, a + 2, a + 6, a + 3, a + 3, a + 6, a + 7); } }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(ug, 3)); sg.setIndex(ui); sg.computeVertexNormals();
    root.add(new THREE.Mesh(sg, toon('#7a7f8c', { side:THREE.DoubleSide })));
  }

  // low brick walls on both sides, one instanced mesh for the bricks and one for their studs
  buildWalls(root){
    const N = this.N, L = 3.2, step = Math.round(L / SPACING), count = Math.floor(N / step) * 2;
    const bg = new THREE.BoxGeometry(1, 1, 1), sg = new THREE.CylinderGeometry(.3, .3, .25, 10);
    const bricks = new THREE.InstancedMesh(bg, toon('#ffffff'), count), st = new THREE.InstancedMesh(sg, toon('#ffffff'), count * 2);
    const palette = [COLORS.red, COLORS.yellow, COLORS.blue, COLORS.white, COLORS.green].map(c => new THREE.Color(c));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let n = 0, ns = 0;
    for (let i = 0; i + step <= N; i += step){
      const a = this.P[i], b = this.P[(i + step) % N];
      for (const side of [-1, 1]){
        const ra = this.R[i], rb = this.R[(i + step) % N], o = HALF_W + .6;
        const ax = a.x + ra.x * o * side, az = a.z + ra.z * o * side, bx = b.x + rb.x * o * side, bz = b.z + rb.z * o * side;
        const len = Math.hypot(bx - ax, bz - az) + .15, h = 1.4, y = (a.y + b.y) / 2;
        e.set(0, Math.atan2(bx - ax, bz - az), 0); q.setFromEuler(e);
        p.set((ax + bx) / 2, y + h / 2, (az + bz) / 2); s.set(1.1, h, len);
        m.compose(p, q, s); bricks.setMatrixAt(n, m);
        const c = palette[((i / step | 0) + (side > 0 ? 2 : 0)) % palette.length]; bricks.setColorAt(n, c);
        for (const f of [-.25, .25]){ const sx = ax + (bx - ax) * (.5 + f), sz = az + (bz - az) * (.5 + f);
          p.set(sx, y + h + .12, sz); s.set(1, 1, 1); m.compose(p, q, s); st.setMatrixAt(ns, m); st.setColorAt(ns, c); ns++; }
        n++;
      }
    }
    bricks.count = n; st.count = ns; root.add(bricks, st);
  }

  /* ---------- canvas textures ---------- */
  canvas(w, h, draw){ const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }
  roadTexture(){
    const t = this.canvas(256, 256, (g, w, h) => {
      g.fillStyle = '#8a7a6a'; g.fillRect(0, 0, w, h);
      // speckles so speed reads well
      const r = mulberry(3); for (let i = 0; i < 900; i++){ g.fillStyle = r() < .5 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.07)'; g.fillRect(r() * w, r() * h, 3, 3); }
      g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(w * .5 - 4, 0, 8, h * .5);
      g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(0, 0, 10, h); g.fillRect(w - 10, 0, 10, h);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  studTexture(){
    const t = this.canvas(64, 64, (g, w, h) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(0,0,0,.14)'; g.beginPath(); g.arc(w / 2 + 2, h / 2 + 3, 18, 0, 7); g.fill();
      g.fillStyle = '#f2fff0'; g.beginPath(); g.arc(w / 2, h / 2, 18, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(w / 2 - 6, h / 2 - 6, 5, 0, 7); g.fill();
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(.5, .5); return t;
  }
  checkerTexture(){
    const t = this.canvas(256, 64, (g, w, h) => { const n = 12; for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++){ g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(i * w / n, j * h / 3, w / n + 1, h / 3 + 1); } });
    return t;
  }
  bannerTexture(){
    return this.canvas(1024, 128, (g, w, h) => {
      g.fillStyle = '#ffcd03'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 16; i++){ g.fillStyle = i % 2 ? '#111' : '#fff'; g.fillRect(i * w / 16, 0, w / 16, 14); g.fillRect(i * w / 16, h - 14, w / 16, 14); g.fillStyle = i % 2 ? '#fff' : '#111'; }
      g.font = '900 78px "Lilita One", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 10; g.strokeStyle = '#b3261e'; g.strokeText('BRICK RACERS', w / 2, h / 2 + 4); g.fillStyle = '#ffffff'; g.fillText('BRICK RACERS', w / 2, h / 2 + 4);
    });
  }
}

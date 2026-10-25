/* ============================================================
   Cartoon brick models: toon materials with a 3-step ramp, black inverted-hull outlines,
   karts with a minifigure driver, pickup bricks and scenery. Everything is built from
   primitives, so there are no model files to load.
   ============================================================ */
import * as THREE from 'three';

export const COLORS = {
  red:'#e3242b', yellow:'#ffcd03', blue:'#1e6fe8', green:'#2fb24c', white:'#f4f4f4',
  black:'#1b1b22', gray:'#9ba1ad', dark:'#4a4f5c', skin:'#ffd21f', brown:'#7b4a26', orange:'#ff7a12', tan:'#e8c88a', lime:'#9bd61f',
};
export const PLAYER_COLORS = ['#e3242b', '#1e6fe8', '#ffcd03', '#2fb24c', '#ff7a12'];

// three tones: shadow, mid, lit (nearest filtering gives the hard cartoon bands)
const ramp = (() => {
  const d = new Uint8Array([90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t;
})();
const mats = new Map();
export function toon(color, opts){
  const key = color + (opts ? JSON.stringify(opts) : '');
  if (!mats.has(key)) mats.set(key, new THREE.MeshToonMaterial(Object.assign({ color:new THREE.Color(color), gradientMap:ramp }, opts || {})));
  return mats.get(key);
}
export const basic = (() => { const m = new Map(); return (color, opts) => { const k = color + (opts ? JSON.stringify(opts) : ''); if (!m.has(k)) m.set(k, new THREE.MeshBasicMaterial(Object.assign({ color:new THREE.Color(color) }, opts || {}))); return m.get(k); }; })();
const outlineMat = new THREE.MeshBasicMaterial({ color:0x111118, side:THREE.BackSide });

// a black shell slightly bigger than the mesh, drawn inside out: the classic cartoon outline
export function outline(mesh, px = .06){
  const g = mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
  const s = new THREE.Vector3(); g.boundingBox.getSize(s);
  const o = new THREE.Mesh(g, outlineMat);
  o.scale.set(1 + 2 * px / Math.max(s.x, .05), 1 + 2 * px / Math.max(s.y, .05), 1 + 2 * px / Math.max(s.z, .05));
  o.raycast = () => {}; mesh.add(o); return mesh;
}

const geo = new Map();
const G = (key, make) => { if (!geo.has(key)) geo.set(key, make()); return geo.get(key); };
const box = (w, h, d) => G(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt, rb, h, n = 16) => G(`c${rt},${rb},${h},${n}`, () => new THREE.CylinderGeometry(rt, rb, h, n));
const sph = (r, n = 16) => G(`s${r},${n}`, () => new THREE.SphereGeometry(r, n, Math.max(8, n * .6 | 0)));

export function part(g, color, x = 0, y = 0, z = 0, line = .05){
  const m = new THREE.Mesh(g, typeof color === 'string' ? toon(color) : color);
  m.position.set(x, y, z); if (line) outline(m, line); return m;
}
// studs on top of a w x d brick (in stud units, 1 stud = .8)
export function studs(parent, color, w, d, y, x0 = 0, z0 = 0, size = .8){
  const g = cyl(size * .3, size * .3, size * .22, 12);
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++)
    parent.add(part(g, color, x0 + (i - (w - 1) / 2) * size, y + size * .11, z0 + (j - (d - 1) / 2) * size, .03));
}

/* ---------- minifigure driver (seated) ---------- */
export function minifig(color, helmet){
  const f = new THREE.Group();
  const legs = part(box(1.0, .45, 1.1), COLORS.dark, 0, .25, .35); f.add(legs);
  const hips = part(box(1.0, .3, .5), COLORS.dark, 0, .45, -.05); f.add(hips);
  // torso: a trapezoid made from a 4-sided cylinder
  const tg = G('torso', () => { const g = new THREE.CylinderGeometry(.42, .62, 1.0, 4, 1); g.rotateY(Math.PI / 4); g.scale(1, 1, .62); return g; });
  const torso = part(tg, color, 0, 1.1, -.05); f.add(torso);
  // a white racing stripe on the chest
  torso.add(part(box(.18, .9, .05), COLORS.white, 0, 0, .3, 0));
  const arm = side => { const a = new THREE.Group(); a.position.set(side * .58, 1.42, -.05);
    a.add(part(box(.26, .7, .3), color, 0, -.3, .12)); a.add(part(cyl(.13, .13, .16, 10), COLORS.skin, 0, -.66, .32));
    a.rotation.x = -.9; return a; };
  f.add(arm(-1), arm(1));
  const head = new THREE.Group(); head.position.y = 1.9; f.add(head); f.userData.head = head;
  head.add(part(cyl(.36, .36, .6, 20), COLORS.skin, 0, 0, 0));
  // face: two eyes and a smile
  for (const s of [-1, 1]) head.add(part(sph(.055, 8), COLORS.black, s * .13, .08, .34, 0));
  const smile = new THREE.Mesh(G('smile', () => new THREE.TorusGeometry(.15, .03, 6, 12, Math.PI)), toon(COLORS.black)); smile.rotation.z = Math.PI; smile.position.set(0, -.05, .345); head.add(smile);
  // helmet with a visor
  const hm = new THREE.Mesh(G('helmet', () => new THREE.SphereGeometry(.46, 20, 12, 0, Math.PI * 2, 0, Math.PI * .55)), toon(helmet || color)); hm.position.y = .05; outline(hm, .04); head.add(hm);
  head.add(part(box(.75, .14, .25), COLORS.black, 0, .24, .3, .02));
  return f;
}

/* ---------- kart ---------- */
// forward is +Z. Returns a group with handles for wheels, driver and the shield bubble.
export function kart(color, driverColor, style = 0){
  const k = new THREE.Group(), body = new THREE.Group(); k.add(body); k.userData.body = body;
  const dark = new THREE.Color(color).multiplyScalar(.6).getStyle();
  body.add(part(box(2.4, .4, 3.8), color, 0, .55, 0));               // chassis plate
  studs(body, color, 2, 1, .75, 0, 1.45);
  body.add(part(box(2.0, .55, .9), color, 0, .78, 1.7));             // nose
  body.add(part(box(1.6, .2, .3), COLORS.black, 0, .62, 2.2, .03));  // grille
  for (const s of [-1, 1]) body.add(part(box(.5, .5, 1.8), dark, s * 1.15, .85, -.1)); // side pods
  body.add(part(box(1.3, .25, 1.2), COLORS.dark, 0, .85, -.2));      // seat
  body.add(part(box(1.3, .9, .3), COLORS.dark, 0, 1.25, -.85));      // seat back
  body.add(part(box(1.6, .7, .9), COLORS.gray, 0, 1.05, -1.5));      // engine
  studs(body, COLORS.gray, 2, 1, 1.4, 0, -1.5);
  for (const s of [-1, 1]){ const p = part(cyl(.15, .15, .8, 10), COLORS.white, s * .55, 1.0, -2.05); p.rotation.x = Math.PI / 2 - .3; body.add(p); }
  // spoiler: some karts get a tall wing, some a flat one
  if (style % 2 === 0){
    for (const s of [-1, 1]) body.add(part(box(.15, .8, .2), COLORS.black, s * .8, 1.6, -1.8, .03));
    body.add(part(box(2.4, .18, .7), color, 0, 2.05, -1.85));
  } else body.add(part(box(2.2, .3, .5), color, 0, 1.55, -1.95));
  // steering wheel
  const sw = part(G('wheelring', () => new THREE.TorusGeometry(.28, .06, 6, 14)), COLORS.black, 0, 1.25, .65, 0); sw.rotation.x = -.6; body.add(sw);
  // driver
  const d = minifig(driverColor, color); d.position.set(0, .7, -.25); body.add(d); k.userData.driver = d;
  // wheels: black tyres with white hubs
  k.userData.wheels = [];
  const tyre = G('tyre', () => { const g = new THREE.CylinderGeometry(1, 1, 1, 18); g.rotateZ(Math.PI / 2); return g; });
  const wheel = (x, z, r, w) => { const g = new THREE.Group(); g.position.set(x, r, z);
    const t = part(tyre, COLORS.black, 0, 0, 0, .04); t.scale.set(w, r, r); g.add(t);
    const h = part(tyre, COLORS.white, x > 0 ? w * .3 : -w * .3, 0, 0, 0); h.scale.set(w * .5, r * .55, r * .55); g.add(h);
    k.add(g); k.userData.wheels.push(g); return g; };
  k.userData.front = [wheel(-1.35, 1.35, .5, .5), wheel(1.35, 1.35, .5, .5)];
  wheel(-1.4, -1.35, .62, .62); wheel(1.4, -1.35, .62, .62);
  // shield bubble (hidden until used)
  const sh = new THREE.Mesh(sph(2.8, 20), new THREE.MeshBasicMaterial({ color:0x6fd0ff, transparent:true, opacity:.28, depthWrite:false }));
  sh.position.y = 1.2; sh.visible = false; k.add(sh); k.userData.shield = sh;
  // blob shadow
  const bl = new THREE.Mesh(G('blob', () => new THREE.CircleGeometry(2.2, 20).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:.28, depthWrite:false }));
  bl.position.y = .06; bl.scale.set(1, 1, 1.3); k.add(bl); k.userData.blob = bl;
  // boost flames
  const fl = new THREE.Group(); fl.position.set(0, 1.0, -2.4);
  for (const s of [-1, 1]){ const c = new THREE.Mesh(G('flame', () => new THREE.ConeGeometry(.28, 1.4, 8).rotateX(-Math.PI / 2)), basic(COLORS.orange)); c.position.x = s * .55; fl.add(c);
    const c2 = new THREE.Mesh(G('flame2', () => new THREE.ConeGeometry(.15, .9, 8).rotateX(-Math.PI / 2)), basic('#fff36b')); c2.position.set(s * .55, 0, .1); fl.add(c2); }
  fl.visible = false; k.add(fl); k.userData.flames = fl;
  return k;
}

/* ---------- pickup brick: a 2x2 brick with studs ---------- */
export function brick(color){
  const b = new THREE.Group();
  b.add(part(box(1.6, 1.0, 1.6), color, 0, 0, 0, .06));
  studs(b, color, 2, 2, .5);
  return b;
}

/* ---------- scenery ---------- */
export function tree(rng){
  const t = new THREE.Group(), h = 2 + rng() * 2;
  t.add(part(box(.9, h, .9), COLORS.brown, 0, h / 2, 0));
  const g = ['#2fb24c', '#3fa63a', '#5cc23c'][rng() * 3 | 0];
  const layers = 2 + (rng() * 2 | 0);
  for (let i = 0; i < layers; i++){ const s = 4.2 - i * 1.1; const l = part(box(s, 1.3, s), g, 0, h + .6 + i * 1.3, 0); t.add(l); }
  studs(t, g, 2, 2, h + .6 + (layers - 1) * 1.3 + .65, 0, 0, 1.0);
  return t;
}
export function palm(rng){
  const t = new THREE.Group(), n = 6 + (rng() * 3 | 0), lean = (rng() - .5) * .5;
  for (let i = 0; i < n; i++) t.add(part(cyl(.42, .5, .9, 8), i % 2 ? COLORS.brown : '#8e5a2e', lean * i * .8, .45 + i * .9, 0, .04));
  const top = new THREE.Group(); top.position.set(lean * n * .8, n * .9 + .2, 0); t.add(top);
  for (let i = 0; i < 6; i++){ const a = i / 6 * Math.PI * 2, leaf = part(box(.9, .15, 3.6), '#3fbf3a', 0, 0, 0, .04);
    leaf.position.set(Math.sin(a) * 1.6, -.3, Math.cos(a) * 1.6); leaf.rotation.set(.35, a, 0); top.add(leaf); }
  top.add(part(sph(.4, 8), COLORS.brown, .3, -.3, 0, .03), part(sph(.4, 8), COLORS.brown, -.3, -.4, .2, .03));
  return t;
}
export function house(rng, wall, roof){
  const h = new THREE.Group(), w = 7 + rng() * 4, d = 6 + rng() * 3, hh = 4 + rng() * 2;
  h.add(part(box(w, hh, d), wall, 0, hh / 2, 0, .08));
  // roof from a 3-sided prism
  const r = new THREE.Mesh(G(`roof${w | 0},${d | 0}`, () => { const g = new THREE.CylinderGeometry(1, 1, w + .8, 3); g.rotateZ(Math.PI / 2); g.scale(1, (d * .45), d * .62); return g; }), toon(roof));
  r.position.y = hh + d * .2; outline(r, .08); h.add(r);
  h.add(part(box(1.4, 2.4, .3), COLORS.brown, 0, 1.2, d / 2 + .05, .04));
  for (const s of [-1, 1]){ h.add(part(box(1.4, 1.2, .2), '#9fe3ff', s * w * .3, hh * .6, d / 2 + .05, .04)); }
  return h;
}
export function rock(rng){
  const r = part(G('rock', () => new THREE.DodecahedronGeometry(1, 0)), ['#8b8f99', '#a2a6ae', '#7d818c'][rng() * 3 | 0], 0, .5, 0, .06);
  const s = 1 + rng() * 2.5; r.scale.set(s, s * (.6 + rng() * .4), s); r.rotation.y = rng() * 6; return r;
}
export function cloud(rng){
  const c = new THREE.Group(), n = 3 + (rng() * 3 | 0);
  for (let i = 0; i < n; i++){ const p = new THREE.Mesh(sph(3 + rng() * 3, 12), toon('#ffffff')); p.position.set(i * 4 - n * 2, rng() * 2, rng() * 3); c.add(p); }
  return c;
}
export function flag(color){
  const f = new THREE.Group();
  f.add(part(cyl(.12, .12, 6, 8), COLORS.white, 0, 3, 0, .03));
  const cloth = part(box(2.4, 1.4, .08), color, 1.2, 5.2, 0, .03); f.add(cloth); f.userData.cloth = cloth;
  return f;
}

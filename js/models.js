/* ============================================================
   TekRacers models: low-poly, flat-shaded shapes with neon accents.
   Sleek open-wheel race karts (no drivers), energy-core pickups and canyon scenery,
   all built from primitives so there are no model files to load.
   ============================================================ */
import * as THREE from 'three';

export const COLORS = {
  red:'#ff3b4e', yellow:'#ffc21a', blue:'#2f8bff', green:'#28e07a', white:'#f2f4ff',
  black:'#121318', gray:'#8a90a0', dark:'#2a2d38', carbon:'#1a1c24', steel:'#b8bfcc', orange:'#ff8a2a',
  rock:'#b85c38', rock2:'#d9814f', rock3:'#8e4430', sand:'#e9a86a', pine:'#2f6b4a', cyan:'#3ff6ff', magenta:'#ff3df2',
};
// kart paint for the 5 players
export const PLAYER_COLORS = ['#ff3b4e', '#2f8bff', '#ffc21a', '#28e07a', '#b26bff'];

const mats = new Map();
// flat-shaded standard material (cached by colour and options)
export function mat(color, opts){
  const key = color + (opts ? JSON.stringify(opts) : '');
  if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial(Object.assign({ color:new THREE.Color(color), roughness:.75, metalness:.05, flatShading:true }, opts || {})));
  return mats.get(key);
}
// glowing parts: unlit and bright
export const glow = (() => { const m = new Map(); return (color, opts) => { const k = color + (opts ? JSON.stringify(opts) : ''); if (!m.has(k)) m.set(k, new THREE.MeshBasicMaterial(Object.assign({ color:new THREE.Color(color) }, opts || {}))); return m.get(k); }; })();
export const basic = glow;
export const paint = color => mat(color, { roughness:.32, metalness:.25 });

const geo = new Map();
const G = (key, make) => { if (!geo.has(key)) geo.set(key, make()); return geo.get(key); };
const box = (w, h, d) => G(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt, rb, h, n = 16) => G(`c${rt},${rb},${h},${n}`, () => new THREE.CylinderGeometry(rt, rb, h, n));
export function part(g, material, x = 0, y = 0, z = 0){
  const m = new THREE.Mesh(g, typeof material === 'string' ? mat(material) : material);
  m.position.set(x, y, z); return m;
}

// a soft round shadow texture shared by everything that sits on the ground
export const blobTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 2, 32, 32, 32); r.addColorStop(0, 'rgba(0,0,0,.55)'); r.addColorStop(.6, 'rgba(0,0,0,.25)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); return t;
})();
export function blob(w, d){
  const m = new THREE.Mesh(G('blobG', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), G('blobM', () => new THREE.MeshBasicMaterial({ map:blobTex, transparent:true, depthWrite:false })));
  m.scale.set(w, 1, d); m.renderOrder = 1; return m;
}

/* ---------- race kart ---------- */
// The body is a side profile (z forward, y up) extruded across the width.
function bodyGeo(){
  return G('kbody', () => {
    const s = new THREE.Shape();
    s.moveTo(2.25, .42); s.lineTo(2.35, .62); s.lineTo(1.2, .82); s.lineTo(.55, 1.02); s.lineTo(-.6, 1.12); s.lineTo(-1.6, 1.02); s.lineTo(-2.05, .8); s.lineTo(-2.0, .42); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth:1.3, bevelEnabled:true, bevelSize:.12, bevelThickness:.12, bevelSegments:1 });
    g.translate(0, 0, -.65); g.rotateY(-Math.PI / 2); // profile x -> world z
    return g;
  });
}
function podGeo(){
  return G('kpod', () => {
    const s = new THREE.Shape();
    s.moveTo(1.0, .35); s.lineTo(.6, .78); s.lineTo(-1.2, .82); s.lineTo(-1.45, .35); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth:.5, bevelEnabled:false }); g.translate(0, 0, -.25); g.rotateY(-Math.PI / 2); return g;
  });
}
// forward is +Z. Returns a group with handles for wheels, the shield bubble, flames and the shadow.
export function kart(color, accent, style = 0){
  const k = new THREE.Group(), body = new THREE.Group(); k.add(body); k.userData.body = body;
  const pc = paint(color), dark = paint(new THREE.Color(color).multiplyScalar(.45).getStyle()), carbon = mat(COLORS.carbon, { roughness:.5, metalness:.3 });
  const neon = glow(new THREE.Color(accent || color).lerp(new THREE.Color('#ffffff'), .35).getStyle());
  body.add(part(box(2.2, .22, 3.9), carbon, 0, .36, 0));                       // floor pan
  body.add(new THREE.Mesh(bodyGeo(), pc));                                      // main body
  for (const s of [-1, 1]){
    const pod = new THREE.Mesh(podGeo(), dark); pod.position.x = s * 1.0; body.add(pod);
    body.add(part(box(.06, .07, 2.0), neon, s * 1.27, .62, -.25));               // neon stripe along the pod
  }
  // canopy: smoked glass bubble
  const can = new THREE.Mesh(G('canopy', () => new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)), mat('#0d1424', { roughness:.08, metalness:.6 }));
  can.scale.set(.62, .5, 1.15); can.position.set(0, 1.05, .05); body.add(can);
  body.add(part(box(.14, .5, 1.0), pc, 0, 1.25, -1.15));                        // air intake fin
  // front wing with end plates
  body.add(part(box(2.7, .08, .55), carbon, 0, .4, 2.25));
  for (const s of [-1, 1]) body.add(part(box(.07, .3, .6), pc, s * 1.35, .5, 2.25));
  // rear wing: tall or low depending on the kart
  const wy = style % 2 ? 1.45 : 1.75;
  for (const s of [-1, 1]) body.add(part(box(.1, wy - .8, .25), carbon, s * .55, (wy + .8) / 2, -1.85));
  body.add(part(box(2.6, .1, .7), pc, 0, wy, -1.9));
  body.add(part(box(2.6, .05, .05), neon, 0, wy + .07, -1.56));
  for (const s of [-1, 1]) body.add(part(box(.07, .45, .8), carbon, s * 1.3, wy - .1, -1.9));
  // exhausts with hot cores, head and tail lights
  for (const s of [-1, 1]){
    const ex = part(cyl(.14, .17, .5, 10), mat(COLORS.steel, { roughness:.3, metalness:.8 }), s * .4, .78, -2.12); ex.rotation.x = Math.PI / 2; body.add(ex);
    const hot = part(cyl(.09, .09, .02, 10), glow('#ffb347'), s * .4, .78, -2.38); hot.rotation.x = Math.PI / 2; body.add(hot);
    body.add(part(box(.35, .08, .05), glow('#ffffff'), s * .55, .62, 2.36));
    body.add(part(box(.4, .08, .05), glow('#ff2a3a'), s * .7, .78, -2.06));
  }
  // underglow in the kart's accent colour
  const ug = new THREE.Mesh(G('ugG', () => new THREE.PlaneGeometry(2.6, 4.4).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color:new THREE.Color(accent || color), transparent:true, opacity:.35, depthWrite:false, blending:THREE.AdditiveBlending, map:blobTex }));
  ug.position.y = .08; k.add(ug);
  // wheels: open, with machined rims
  k.userData.wheels = [];
  const tyre = G('tyre', () => { const g = new THREE.CylinderGeometry(1, 1, 1, 18); g.rotateZ(Math.PI / 2); return g; });
  const rimG = G('rim', () => { const g = new THREE.CylinderGeometry(1, 1, 1, 6); g.rotateZ(Math.PI / 2); return g; });
  const wheel = (x, z, r, w) => { const g = new THREE.Group(); g.position.set(x, r, z);
    const spin = new THREE.Group(); g.add(spin);
    const t = part(tyre, mat('#16171c', { roughness:.9 })); t.scale.set(w, r, r); spin.add(t);
    const rim = part(rimG, mat(COLORS.steel, { roughness:.25, metalness:.85 }), x > 0 ? w * .08 : -w * .08, 0, 0); rim.scale.set(w * .9, r * .62, r * .62); spin.add(rim);
    const hub = part(rimG, dark, x > 0 ? w * .12 : -w * .12, 0, 0); hub.scale.set(w * .9, r * .22, r * .22); spin.add(hub);
    k.add(g); k.userData.wheels.push(g); return g; };
  k.userData.front = [wheel(-1.35, 1.45, .48, .5), wheel(1.35, 1.45, .48, .5)];
  wheel(-1.42, -1.35, .62, .7); wheel(1.42, -1.35, .62, .7);
  // shield bubble (hidden until used)
  const sh = new THREE.Mesh(G('shield', () => new THREE.IcosahedronGeometry(3, 1)), new THREE.MeshBasicMaterial({ color:0x6fd0ff, transparent:true, opacity:.22, depthWrite:false, wireframe:false, blending:THREE.AdditiveBlending }));
  sh.position.y = 1.1; sh.visible = false; k.add(sh); k.userData.shield = sh;
  const bl = blob(4.2, 6); bl.position.y = .06; k.add(bl); k.userData.blob = bl;
  // boost flames
  const fl = new THREE.Group(); fl.position.set(0, .78, -2.5);
  for (const s of [-1, 1]){ const c = new THREE.Mesh(G('flame', () => new THREE.ConeGeometry(.2, 1.6, 8).rotateX(-Math.PI / 2)), glow('#4fd2ff', { transparent:true, opacity:.85, blending:THREE.AdditiveBlending, depthWrite:false })); c.position.x = s * .4; fl.add(c);
    const c2 = new THREE.Mesh(G('flame2', () => new THREE.ConeGeometry(.1, 1.0, 8).rotateX(-Math.PI / 2)), glow('#ffffff')); c2.position.set(s * .4, 0, .15); fl.add(c2); }
  fl.visible = false; k.add(fl); k.userData.flames = fl;
  return k;
}

/* ---------- energy core pickup: a spinning crystal in a ring ---------- */
export function core(color){
  const b = new THREE.Group();
  const white = color === COLORS.white;
  const shell = new THREE.Mesh(G('coreG', () => new THREE.OctahedronGeometry(1.05, 0)), mat(color, { roughness:.2, metalness:.1, emissive:new THREE.Color(color), emissiveIntensity:.55, transparent:true, opacity:.88 }));
  shell.scale.y = 1.35; b.add(shell);
  const inner = new THREE.Mesh(G('coreIn', () => new THREE.OctahedronGeometry(.45, 0)), glow('#ffffff')); inner.scale.y = 1.35; b.add(inner);
  const ring = new THREE.Mesh(G('coreRing', () => new THREE.TorusGeometry(1.55, .07, 6, 28)), glow(white ? '#ffffff' : color)); ring.rotation.x = Math.PI / 2; b.add(ring);
  b.userData.ring = ring; b.userData.shell = shell;
  return b;
}

/* ---------- canyon scenery ---------- */
function jitter(g, amt, rng){
  const p = g.attributes.position, seen = new Map();
  for (let i = 0; i < p.count; i++){
    const k = p.getX(i).toFixed(3) + ',' + p.getY(i).toFixed(3) + ',' + p.getZ(i).toFixed(3);
    if (!seen.has(k)) seen.set(k, [(rng() - .5) * amt, (rng() - .5) * amt, (rng() - .5) * amt]);
    const d = seen.get(k); p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  g.computeVertexNormals(); return g;
}
const ROCKS = [COLORS.rock, COLORS.rock2, COLORS.rock3, '#c96f45'];
export function rock(rng, s = 1){
  const g = jitter(new THREE.IcosahedronGeometry(1, 0), .5, rng);
  const r = new THREE.Mesh(g, mat(ROCKS[rng() * ROCKS.length | 0]));
  const k = (1 + rng() * 2.5) * s; r.scale.set(k * (.8 + rng() * .6), k * (.5 + rng() * .5), k * (.8 + rng() * .6)); r.position.y = k * .25; r.rotation.y = rng() * 6;
  return r;
}
// a layered table-top mesa
export function mesa(rng){
  const m = new THREE.Group(), r = 14 + rng() * 22, h = 18 + rng() * 30, n = 2 + (rng() * 2 | 0);
  let y = 0;
  for (let i = 0; i < n; i++){
    const hh = h / n * (i === n - 1 ? 1.1 : 1), rt = r * (1 - (i + 1) * .16), rb = r * (1 - i * .16);
    const c = new THREE.Mesh(jitter(new THREE.CylinderGeometry(rt, rb, hh, 7 + (rng() * 3 | 0), 1), 2.5, rng), mat(ROCKS[(i + (rng() * 2 | 0)) % ROCKS.length]));
    c.position.y = y + hh / 2; m.add(c); y += hh;
  }
  m.rotation.y = rng() * 6; return m;
}
export function pine(rng){
  const t = new THREE.Group(), h = 1 + rng() * 1.2;
  t.add(part(cyl(.25, .35, 2 * h, 6), mat('#5a3a26'), 0, h, 0));
  const tones = ['#2f6b4a', '#3a7d52', '#285c40'], c = tones[rng() * 3 | 0];
  for (let i = 0; i < 3; i++) t.add(part(G('pine' + i, () => new THREE.ConeGeometry(2.4 - i * .6, 2.6, 7)), mat(c), 0, 2 * h + .6 + i * 1.5, 0));
  t.scale.setScalar(1.2 + rng() * .8); return t;
}
export function cactus(rng){
  const t = new THREE.Group(), h = 3 + rng() * 3, m = mat('#4f8a4a');
  t.add(part(cyl(.45, .5, h, 7), m, 0, h / 2, 0));
  for (const s of [-1, 1]) if (rng() < .8){ const y = h * (.35 + rng() * .3), a = 1 + rng();
    t.add(part(cyl(.3, .3, 1, 6), m, s * .8, y, 0).rotateZ(Math.PI / 2));
    t.add(part(cyl(.3, .3, a, 6), m, s * 1.2, y + a / 2, 0)); }
  t.rotation.y = rng() * 6; return t;
}
export function shrub(rng){
  const s = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(1, 0), .4, rng), mat(['#8a8f4a', '#6f7a3c', '#a39552'][rng() * 3 | 0]));
  const k = .8 + rng() * 1.2; s.scale.set(k, k * .6, k); s.position.y = k * .3; return s;
}
// a light tower with a glowing head
export function pylon(color){
  const p = new THREE.Group();
  p.add(part(cyl(.22, .32, 9, 6), mat(COLORS.dark, { metalness:.5, roughness:.4 }), 0, 4.5, 0));
  p.add(part(box(1.8, .3, .5), mat(COLORS.dark), 0, 9, 0));
  p.add(part(box(1.6, .18, .52), glow(color), 0, 8.85, 0));
  return p;
}

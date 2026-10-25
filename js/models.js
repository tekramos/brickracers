/* ============================================================
   TekRacers models, built from primitives (no files to load): chunky rounded karts with glowing
   lights, energy-core pickups and the pieces of the park circuit (trees, rocks, lamps, fences).
   All of them use the shared stylised material from look.js.
   ============================================================ */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { stylize, emissive } from './look.js';

export const COLORS = {
  red:'#ff4a5a', yellow:'#ffc93c', blue:'#3aa0ff', green:'#62e05a', white:'#fff4e6',
  black:'#1b1424', dark:'#2d2438', gray:'#8f86a3', steel:'#c9c3d6', orange:'#ff8a3d',
  rubber:'#2b2433', glass:'#2a2346', wood:'#c98a5a', woodDark:'#8a5a43', stone:'#b9a8c4', road:'#463f35',
};
// kart paint for the 5 players
export const PLAYER_COLORS = ['#ff5a4e', '#3f8cff', '#ffbe3b', '#3fd68a', '#b36bff'];

const geo = new Map();
const G = (key, make) => { if (!geo.has(key)) geo.set(key, make()); return geo.get(key); };
const rbox = (w, h, d, r = .12, s = 2) => G(`rb${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, s, r));
const box = (w, h, d) => G(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt, rb, h, n = 12) => G(`c${rt},${rb},${h},${n}`, () => new THREE.CylinderGeometry(rt, rb, h, n));
export function part(g, material, x = 0, y = 0, z = 0, shadow = true){
  const m = new THREE.Mesh(g, typeof material === 'string' ? stylize(material) : material);
  m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; return m;
}
const darker = (c, k) => '#' + new THREE.Color(c).multiplyScalar(k).getHexString();

/* ---------- soft contact shadow under things that move ---------- */
export const blobTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 4, 32, 32, 32); r.addColorStop(0, 'rgba(30,8,60,.55)'); r.addColorStop(1, 'rgba(30,8,60,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
export function blob(w, d){
  const m = new THREE.Mesh(G('blobG', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), G('blobM', () => new THREE.MeshBasicMaterial({ map:blobTex, transparent:true, depthWrite:false })));
  m.scale.set(w, 1, d); m.renderOrder = 1; return m;
}

/* ---------- the kart: a chunky little rally buggy ---------- */
function wheel(rim){
  const w = new THREE.Group(), spin = new THREE.Group(); w.add(spin);
  const tyre = part(G('tyre', () => new THREE.CylinderGeometry(.62, .62, .52, 14).rotateZ(Math.PI / 2)), COLORS.rubber); spin.add(tyre);
  // chunky tread blocks so the spin reads
  for (let i = 0; i < 8; i++){ const a = i / 8 * Math.PI * 2, t = part(box(.54, .14, .2), COLORS.rubber, 0, Math.cos(a) * .62, Math.sin(a) * .62, false); t.rotation.x = -a; spin.add(t); }
  const hub = part(G('rim', () => new THREE.CylinderGeometry(.36, .36, .56, 10).rotateZ(Math.PI / 2)), rim, 0, 0, 0, false); spin.add(hub);
  const cap = part(G('cap', () => new THREE.CylinderGeometry(.12, .12, .6, 6).rotateZ(Math.PI / 2)), COLORS.dark, 0, 0, 0, false); spin.add(cap);
  return w;
}
export function kart(color, accent){
  const k = new THREE.Group(), body = new THREE.Group(); k.add(body); k.userData.body = body;
  const paint = stylize(color), trim = stylize(darker(color, .55)), dark = stylize(COLORS.dark), glass = stylize(COLORS.glass);
  const rim = accent || COLORS.white;
  body.add(part(rbox(2.2, .42, 3.9, .14), dark, 0, .62, 0));                 // chassis
  body.add(part(rbox(2.06, .58, 3.5, .2), paint, 0, 1.0, .05));              // body
  body.add(part(rbox(1.7, .2, 1.3, .1), paint, 0, 1.32, .95));               // hood bulge
  body.add(part(rbox(.7, .16, .6, .06), dark, 0, 1.45, 1.05));               // scoop
  body.add(part(rbox(1.62, .62, 1.6, .16), glass, 0, 1.55, -.45));           // cabin glass
  body.add(part(rbox(1.68, .14, 1.66, .07), paint, 0, 1.9, -.47));           // roof
  body.add(part(rbox(1.9, .1, .5, .05), trim, 0, 1.62, -1.75));              // spoiler
  for (const s of [-1, 1]) body.add(part(box(.1, .38, .12), dark, s * .7, 1.42, -1.72));
  // fenders over each wheel
  for (const [x, z] of [[-1.08, 1.25], [1.08, 1.25], [-1.08, -1.2], [1.08, -1.2]]) body.add(part(rbox(.5, .32, 1.2, .14), trim, x, 1.12, z));
  // bumpers and a stripe
  body.add(part(rbox(2.2, .3, .3, .12), dark, 0, .72, 1.95));
  body.add(part(rbox(2.0, .3, .3, .12), dark, 0, .72, -1.9));
  body.add(part(box(.36, .02, 3.3), stylize(rim), 0, 1.3, .05, false));
  // lights: two headlamps, a roof bar and tail lights (they glow, more at night)
  const head = emissive('#ffe2a1', 1.8, { dim:true }), tail = emissive('#ff2848', 1.6, { dim:true });
  for (const s of [-1, 1]){ body.add(part(box(.46, .18, .08), head, s * .68, 1.02, 1.82, false)); body.add(part(box(.4, .14, .08), tail, s * .7, 1.02, -1.83, false)); }
  for (let i = 0; i < 4; i++) body.add(part(box(.22, .1, .12), head, (i - 1.5) * .32, 1.99, .3, false));
  body.add(part(box(1.3, .08, .12), dark, 0, 1.98, .3, false));
  // exhausts and boost flames
  for (const s of [-1, 1]) body.add(part(cyl(.11, .11, .5, 8).rotateX(Math.PI / 2), COLORS.steel, s * .5, .62, -2.02, false));
  const flames = new THREE.Group(); flames.position.set(0, .62, -2.2);
  for (const s of [-1, 1]){ const f = new THREE.Mesh(G('flame', () => new THREE.ConeGeometry(.2, 1.3, 7).rotateX(-Math.PI / 2).translate(0, 0, -.6)), emissive('#ff8a2a', 2.6)); f.position.x = s * .5; flames.add(f);
    const c = new THREE.Mesh(G('flameIn', () => new THREE.ConeGeometry(.1, .8, 6).rotateX(-Math.PI / 2).translate(0, 0, -.35)), emissive('#fff2b0', 3)); c.position.x = s * .5; flames.add(c); }
  flames.visible = false; body.add(flames);
  // wheels: groups whose first child spins; the front ones steer
  const wheels = [], front = [];
  for (const [x, z, f] of [[-1.12, 1.25, 1], [1.12, 1.25, 1], [-1.12, -1.2, 0], [1.12, -1.2, 0]]){
    const w = wheel(rim); w.position.set(x, .62, z); k.add(w); wheels.push(w); if (f) front.push(w);
  }
  // shield bubble
  const shield = new THREE.Mesh(G('shield', () => new THREE.IcosahedronGeometry(3, 1)), new THREE.MeshBasicMaterial({ color:'#7fe0ff', transparent:true, opacity:.25, depthWrite:false, blending:THREE.AdditiveBlending }));
  shield.position.y = 1.2; shield.visible = false; k.add(shield);
  const bl = blob(3.4, 5); bl.position.y = .05; k.add(bl);
  Object.assign(k.userData, { wheels, front, shield, flames, blob:bl });
  return k;
}

/* ---------- energy core pickup: a glowing crystal with a ring ---------- */
export function core(colorHex){
  const b = new THREE.Group();
  const shell = new THREE.Mesh(G('coreG', () => new THREE.OctahedronGeometry(1, 0)), emissive(colorHex, 1.35));
  shell.scale.set(.9, 1.25, .9); b.add(shell);
  const inner = new THREE.Mesh(G('coreIn', () => new THREE.OctahedronGeometry(.42, 0)), emissive('#ffffff', 2.5)); inner.scale.y = 1.3; b.add(inner);
  const ring = new THREE.Mesh(G('coreRing', () => new THREE.TorusGeometry(1.5, .08, 6, 28)), emissive(colorHex, 2)); ring.rotation.x = Math.PI / 2; b.add(ring);
  b.userData.ring = ring; b.userData.shell = shell;
  return b;
}

/* ---------- scenery pieces (geometries for instancing) ---------- */
export function jitter(g, amt, rnd){
  g = g.toNonIndexed(); const p = g.attributes.position, seen = new Map();
  for (let i = 0; i < p.count; i++){
    const key = p.getX(i).toFixed(2) + ',' + p.getY(i).toFixed(2) + ',' + p.getZ(i).toFixed(2);
    if (!seen.has(key)) seen.set(key, [(rnd() - .5) * amt, (rnd() - .5) * amt, (rnd() - .5) * amt]);
    const d = seen.get(key); p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  g.computeVertexNormals(); return g;
}
export const trunkGeometry = () => G('trunk', () => {
  // a trunk with two short branches, 1 unit = trunk height
  const parts = [new THREE.CylinderGeometry(.09, .16, 1, 7).translate(0, .5, 0)];
  const br = (a, t) => { const c = new THREE.CylinderGeometry(.05, .08, .45, 6).translate(0, .22, 0); c.rotateZ(t); c.rotateY(a); c.translate(0, .62, 0); return c; };
  parts.push(br(0, .8), br(2.4, .7), br(4.4, .9));
  return mergeAll(parts);
});
export const rockGeometry = (rnd) => jitter(new THREE.DodecahedronGeometry(1, 0), .5, rnd);
export function mergeAll(list){
  const pos = [], nor = [], idx = []; let off = 0;
  for (let g of list){
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++){ pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off); else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setIndex(idx);
  return g;
}
// a park lamp: post, lantern and a warm glow
export function lamp(){
  const g = new THREE.Group();
  g.add(part(cyl(.32, .4, .5, 8), COLORS.dark, 0, .25, 0));
  g.add(part(cyl(.12, .14, 5.2, 8), COLORS.dark, 0, 2.9, 0));
  g.add(part(box(1, .14, 1), COLORS.dark, 0, 5.55, 0));
  g.add(part(box(.72, .9, .72), emissive('#ffcf7a', 1.7, { dim:true }), 0, 6.08, 0, false));
  g.add(part(G('lampTop', () => new THREE.ConeGeometry(.75, .55, 4).rotateY(Math.PI / 4)), COLORS.dark, 0, 6.8, 0));
  return g;
}

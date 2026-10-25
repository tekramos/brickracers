/* ============================================================
   TekRacers look: the stylised lighting every surface shares, in the spirit of Bruno Simon's
   folio-2025 (MIT, github.com/brunosimon/folio-2025), rewritten for this game.
   - one warm key light; faces turned away from it, and cast shadows, blend towards the
     surface colour tinted by a deep shadow colour (no grey, no black)
   - surfaces near the ground pick up a little bounce light from it
   - a screen-space colour gradient is both the sky and the fog, so far things melt into it
   - glowing parts are brighter than white so the bloom pass catches them
   - a see-through cut around the player's kart for anything above it (tunnel hill, trees)
   Time-of-day presets drive all of it through shared uniforms.
   ============================================================ */
import * as THREE from 'three';
import { Fn, uniform, color, float, vec2, vec3, vec4, mix, max, positionWorld, normalWorld, cameraPosition, texture, viewportUV,
  rangeFogFactor, frontFacing, If, luminance, screenCoordinate, fract, dot, uv, rotateUV, attribute } from 'three/tsl';

// presets: light colour and strength, shadow tint, sky/fog gradient (centre, edge), fog range as a share of the view
export const PRESETS = {
  day:   { light:'#ffd2c2', power:1.2, shadow:'#6d3fff', fogA:'#7ff0ff', fogB:'#9b89ff', near:.32, far:1.25, glow:.15 },
  dusk:  { light:'#ff9c8c', power:1.2, shadow:'#4e009c', fogA:'#4a5cff', fogB:'#ff4ce4', near:.05, far:1.25, glow:.55 },
  night: { light:'#5a64ff', power:2.6, shadow:'#2f00db', fogA:'#152a7a', fogB:'#490a42', near:-.6, far:1.05, glow:1 },
  dawn:  { light:'#ffa882', power:1.2, shadow:'#db004f', fogA:'#f885ff', fogB:'#ff7d24', near:.3,  far:1.25, glow:.35 },
};

export const L = {
  dir: uniform(new THREE.Vector3(-.55, .62, -.56).normalize()),
  lightColor: uniform(new THREE.Color('#ffffff')),
  power: uniform(1.2),
  shadowColor: uniform(new THREE.Color('#4e009c')),
  fogA: uniform(new THREE.Color('#4a5cff')),
  fogB: uniform(new THREE.Color('#ff4ce4')),
  fogNear: uniform(60), fogFar: uniform(320),
  bounce: uniform(new THREE.Color('#d9a05b')),
  coreLow: uniform(-.25), coreHigh: uniform(1),
  glow: uniform(.5),                                       // how much the lamps and lights shine (more at night)
  cut: uniform(new THREE.Vector3(0, -999, 0)),             // the kart the current view follows
  cutR: uniform(7.5),
  time: uniform(0),
};
export const look = { preset:'dusk', nd:50, fd:160 };

const tmp = new THREE.Color();
// blend between two presets (t = 0..1), or set one
export function setPreset(a, b = a, t = 0){
  const A = PRESETS[a], B = PRESETS[b], lerp = (x, y) => x + (y - x) * t;
  const col = (u, x, y) => u.value.set(x).lerp(tmp.set(y), t);
  col(L.lightColor, A.light, B.light); col(L.shadowColor, A.shadow, B.shadow); col(L.fogA, A.fogA, B.fogA); col(L.fogB, A.fogB, B.fogB);
  L.power.value = lerp(A.power, B.power); L.glow.value = lerp(A.glow, B.glow);
  const amp = look.fd - look.nd; L.fogNear.value = look.nd + amp * lerp(A.near, B.near); L.fogFar.value = look.nd + amp * lerp(A.far, B.far);
  look.preset = t < .5 ? a : b;
}
// fog range in world units: how far the camera sees the ground at the bottom (nd) and top (fd) of the view
export function setFogRange(nd, fd){ look.nd = nd; look.fd = fd; setPreset(look.preset); }

/* ---------- shared textures, drawn on canvases ---------- */
function canvasTex(size, draw, wrap = true){
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace; return t;
}
// tileable smooth noise (red channel, 0..1): three octaves of value noise on wrapping grids
export const noiseTex = canvasTex(128, (g, S) => {
  let seed = 7; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const octs = [16, 32, 64].map(P => { const v = []; for (let i = 0; i < P * P; i++) v.push(rnd()); return { P, v }; });
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++){
    let val = 0, amp = .57;
    for (const { P, v } of octs){
      const fx = x / S * P, fy = y / S * P, xi = Math.floor(fx), yi = Math.floor(fy), u = fx - xi, w = fy - yi;
      const su = u * u * (3 - 2 * u), sw = w * w * (3 - 2 * w), at = (a, b) => v[(b % P) * P + (a % P)];
      val += amp * (at(xi, yi) * (1 - su) * (1 - sw) + at(xi + 1, yi) * su * (1 - sw) + at(xi, yi + 1) * (1 - su) * sw + at(xi + 1, yi + 1) * su * sw);
      amp *= .5;
    }
    const k = (y * S + x) * 4, c = Math.max(0, Math.min(255, val * 255));
    img.data[k] = img.data[k + 1] = img.data[k + 2] = c; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
});
// a leaf cluster: bright in the middle, fading to the edges in five lobes (cut with a threshold)
export const leafTex = canvasTex(64, (g, S) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  const blob = (x, y, r, a) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); };
  blob(S / 2, S / 2, S * .34, .75);
  for (let i = 0; i < 5; i++){ const a = i / 5 * Math.PI * 2 + .3; blob(S / 2 + Math.cos(a) * S * .18, S / 2 + Math.sin(a) * S * .18, S * .2, .55); }
}, false);
// soft round glow for halos
export const haloTex = canvasTex(64, (g, S) => {
  // opaque white-to-black (a transparent canvas would upload as white everywhere)
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, '#fff'); gr.addColorStop(.2, '#6a6a6a'); gr.addColorStop(.55, '#1c1c1c'); gr.addColorStop(1, '#000');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
}, false);

/* ---------- nodes ---------- */
// the sky and the fog share this gradient
export const fogColor = mix(L.fogA, L.fogB, viewportUV.sub(vec2(.5, .42)).length().smoothstep(.05, .85));
export const windAt = Fn(([p]) => {
  const n1 = texture(noiseTex, p.mul(.02).add(vec2(L.time.mul(.05), L.time.mul(.03)))).r.sub(.5);
  const n2 = texture(noiseTex, p.mul(.007).add(vec2(L.time.mul(.012), 0))).r.sub(.5);
  return vec2(.6, .8).mul(n1.add(n2));
});
// a stable per-pixel dither (interleaved gradient noise)
const dither = Fn(() => fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(.06711056, .00583715))))));
// see-through around the followed kart: hide what sits above it between it and the camera
// (a plain function so the discard lands inline in the calling shader function)
export function cutaway(){
  const k = L.cut, ab = cameraPosition.sub(k), t = positionWorld.sub(k).dot(ab).div(ab.dot(ab)).clamp(0, 1);
  const d = positionWorld.sub(k.add(ab.mul(t))).length();
  const edge = d.sub(L.cutR.mul(.78)).div(L.cutR.mul(.22));
  edge.lessThan(dither()).and(positionWorld.y.greaterThan(k.y.add(2.6))).and(t.greaterThan(.02)).discard();
}

/* ---------- materials ---------- */
const cache = new Map();
/**
 * The shared stylised material.
 * c: colour (hex) or a colour node. o: { normal, alpha, alphaTest, shadow (extra shadow amount node), side,
 *   core:false (no core shadow), drop:false (no cast shadows), bounce:false, fog:false, cut:true (see-through), position }
 */
export function stylize(c = '#ffffff', o = {}){
  const key = typeof c === 'string' && !Object.keys(o).length ? c : null;
  if (key && cache.has(key)) return cache.get(key);
  const m = new THREE.MeshLambertNodeMaterial();
  m.side = o.side ?? THREE.FrontSide;
  if (o.transparent) m.transparent = true;
  const colorNode = c && c.isNode ? c : color(new THREE.Color(c));
  const normalNode = o.normal ?? normalWorld;
  const caught = float(1).toVar();
  if (o.drop !== false) m.receivedShadowNode = Fn(([s]) => { caught.mulAssign(s.r); return float(1); });
  if (o.position) m.positionNode = o.position;
  m.outputNode = Fn(() => {
    const base = vec3(colorNode).toVar(), out = vec3(base).toVar(), n = vec3(normalNode).toVar();
    if (m.side !== THREE.FrontSide) If(frontFacing.not(), () => { n.mulAssign(-1); });
    // bounce light from the ground on faces looking down, close to it
    if (o.bounce !== false){
      const facing = n.dot(vec3(0, -1, 0)).smoothstep(-1, 1), near = float(2.5).sub(positionWorld.y.max(0)).div(2.5).max(0).pow(2);
      out.assign(mix(out, L.bounce, facing.mul(near).mul(.7)));
    }
    out.mulAssign(L.lightColor.mul(L.power));
    let sh = float(0);
    if (o.core !== false) sh = float(1).sub(n.dot(L.dir).smoothstep(L.coreLow, L.coreHigh));
    if (o.drop !== false) sh = max(sh, caught.oneMinus());
    if (o.shadow) sh = max(sh, o.shadow);
    out.assign(mix(out, base.mul(L.shadowColor), sh.clamp(0, 1)));
    if (o.fog !== false) out.assign(mix(out, fogColor, rangeFogFactor(L.fogNear, L.fogFar)));
    if (o.alpha) o.alpha.lessThan(o.alphaTest ?? .1).discard();
    if (o.cut) cutaway();
    return vec4(out, o.opacity ?? 1);
  })();
  if (key) cache.set(key, m);
  return m;
}
// glowing parts: brighter than white (normalised by luminance) so bloom picks them up; `k` scales with the time of day
const glowCache = new Map();
export function emissive(hex, k = 2, o = {}){
  const key = hex + k + (o.transparent ? 't' : '') + (o.dim ? 'd' : '') + (o.cut ? 'c' : '');
  if (glowCache.has(key)) return glowCache.get(key);
  const m = new THREE.MeshBasicNodeMaterial();
  const c = color(new THREE.Color(hex)), strength = o.dim ? float(k).mul(L.glow.mul(.6).add(.4)) : float(k);
  m.outputNode = Fn(() => {
    const out = c.div(luminance(c).max(.05)).mul(strength).toVar();
    out.assign(mix(out, fogColor, rangeFogFactor(L.fogNear, L.fogFar).mul(.8)));
    if (o.cut) cutaway();
    return vec4(out, o.opacity ?? 1);
  })();
  if (o.transparent){ m.transparent = true; m.depthWrite = false; }
  glowCache.set(key, m); return m;
}
// additive halo sprite material (around lamps and lights), stronger at night
const haloCache = new Map();
export function haloMat(hex){
  if (haloCache.has(hex)) return haloCache.get(hex);
  const m = new THREE.SpriteNodeMaterial({ transparent:true, depthWrite:false, blending:THREE.AdditiveBlending });
  m.colorNode = color(new THREE.Color(hex)).mul(texture(haloTex).r).mul(L.glow.mul(.8).add(.08));
  m.fog = false;
  haloCache.set(hex, m); return m;
}

/* ---------- the key light and its shadow, following what each view looks at ---------- */
export function makeSun(scene, quality){
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  const S = sun.shadow; S.mapSize.set(quality === 'low' ? 1024 : 2048, quality === 'low' ? 1024 : 2048);
  S.bias = -.0008; S.normalBias = .12; S.radius = quality === 'low' ? 2 : 3;
  scene.add(sun); scene.add(sun.target);
  sun.userData.extent = 0;
  sun.aim = (focus, extent) => {
    if (sun.userData.extent !== extent){
      const c = S.camera; c.left = c.bottom = -extent; c.right = c.top = extent; c.near = 1; c.far = extent * 2 + 160; c.updateProjectionMatrix();
      sun.userData.extent = extent;
    }
    // snap to shadow texels so the shadows don't shimmer as the camera moves
    const step = extent * 2 / S.mapSize.x, fx = Math.round(focus.x / step) * step, fz = Math.round(focus.z / step) * step;
    sun.target.position.set(fx, focus.y, fz);
    sun.position.set(fx + L.dir.value.x * (extent + 80), focus.y + L.dir.value.y * (extent + 80), fz + L.dir.value.z * (extent + 80));
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  };
  return sun;
}

/* ---------- foliage: a puff of leaf cards that reads as a soft clump ---------- */
export function foliageGeometry(count, rnd){
  const pos = [], nor = [], uvs = [], idx = [];
  const v = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < count; i++){
    const r = 1 - Math.pow(rnd(), 3), th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
    const c = new THREE.Vector3().setFromSphericalCoords(r, ph, th), radial = c.clone().normalize();
    e.set(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3); q.setFromEuler(e);
    const b = pos.length / 3;
    for (const [x, y, u, w] of [[-.42, -.42, 0, 0], [.42, -.42, 1, 0], [.42, .42, 1, 1], [-.42, .42, 0, 1]]){
      v.set(x, y, 0).applyQuaternion(q).add(c); pos.push(v.x, v.y, v.z);
      const n = v.clone().lerp(radial, .85).normalize(); nor.push(n.x, n.y, n.z); uvs.push(u, w);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(idx);
  return g;
}
// leaves: two colours across the light, cut out by the leaf texture, gently shimmering in the wind
export function foliageMaterial(colA, colB, cut = true){
  const a = color(new THREE.Color(colA)), b = color(new THREE.Color(colB));
  const tint = mix(a, b, normalWorld.dot(L.dir).smoothstep(0, 1));
  const alpha = Fn(() => {
    const r = rotateUV(uv(), windAt(positionWorld.xz).length().mul(2.2), vec2(.5));
    return texture(leafTex, r).r.sub(.32);
  })();
  const m = stylize(tint, { alpha, alphaTest:.1, side:THREE.DoubleSide, cut, bounce:false });
  m.maskShadowNode = texture(leafTex).r.greaterThan(.45);
  return m;
}

/* ---------- pooled particles: dust, sparks and puffs without creating meshes in the race ---------- */
export class Particles {
  constructor(parent, count = 400){
    const g = new THREE.IcosahedronGeometry(1, 0);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    g.setAttribute('pcol', this.col);
    const m = stylize(attribute('pcol', 'vec3'), { drop:false, bounce:false });
    this.mesh = new THREE.InstancedMesh(g, m, count); this.mesh.frustumCulled = false; this.mesh.castShadow = false;
    this.mesh.count = 0; parent.add(this.mesh);
    this.list = []; this.max = count; this.o = new THREE.Object3D();
  }
  // kind: 'puff' (rises and grows), 'dust' (low, drifts), 'shard' (flies and falls), 'spark' (bright, fast)
  // gy: the ground height shards bounce on; sparks are brighter than white so they bloom
  add(x, y, z, vx, vy, vz, size, life, colorHex, kind, gy = y - 1.2){
    if (this.list.length >= this.max) this.list.shift();
    tmp.set(colorHex); const k = kind === 'spark' ? 3 : 1;
    this.list.push({ x, y, z, vx, vy, vz, s:size, life, max:life, r:tmp.r * k, g:tmp.g * k, b:tmp.b * k, kind, gy, rot:Math.random() * 6, spin:(Math.random() - .5) * 10 });
  }
  update(dt){
    const o = this.o, arr = this.col.array; let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--){
      const p = this.list[i]; p.life -= dt;
      if (p.life <= 0){ this.list.splice(i, 1); continue; }
      const k = p.life / p.max;
      if (p.kind === 'shard' || p.kind === 'spark'){ p.vy -= 28 * dt; if (p.y < p.gy + .2 && p.vy < 0){ p.vy *= -.35; p.vx *= .6; p.vz *= .6; } }
      else { const d = Math.exp(-dt * (p.kind === 'dust' ? 2.5 : 1.5)); p.vx *= d; p.vz *= d; p.vy *= d; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rot += p.spin * dt;
      const s = p.kind === 'puff' || p.kind === 'dust' ? p.s * (1 + (1 - k) * 1.2) * Math.min(1, k * 2.5) : p.s * Math.min(1, k * 3);
      o.position.set(p.x, p.y, p.z); o.rotation.set(p.rot, p.rot * .7, 0); o.scale.setScalar(s); o.updateMatrix();
      this.mesh.setMatrixAt(n, o.matrix); arr[n * 3] = p.r; arr[n * 3 + 1] = p.g; arr[n * 3 + 2] = p.b; n++;
    }
    this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true; this.col.needsUpdate = true;
  }
}

/* ---------- tyre marks: short dark quads laid on the road while sliding ---------- */
export class Skids {
  constructor(parent, count = 900){
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(count), 1); g.setAttribute('skidA', this.alpha);
    const m = new THREE.MeshBasicNodeMaterial({ transparent:true, depthWrite:false });
    m.colorNode = vec3(.12, .08, .16);
    m.opacityNode = attribute('skidA', 'float').mul(.45);
    m.polygonOffset = true; m.polygonOffsetFactor = -2;
    this.mesh = new THREE.InstancedMesh(g, m, count); this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
    this.mesh.count = count; parent.add(this.mesh);
    this.i = 0; this.max = count; this.o = new THREE.Object3D(); this.born = new Float32Array(count).fill(-99); this.t = 0;
    const z = new THREE.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, z);
  }
  add(x, y, z, h, len, w){
    const o = this.o; o.position.set(x, y + .06, z); o.rotation.set(0, h, 0); o.scale.set(w, 1, len); o.updateMatrix();
    this.mesh.setMatrixAt(this.i, o.matrix); this.born[this.i] = this.t; this.i = (this.i + 1) % this.max; this.mesh.instanceMatrix.needsUpdate = true;
  }
  update(dt){
    this.t += dt; const a = this.alpha.array;
    for (let i = 0; i < this.max; i++){ const age = this.t - this.born[i]; a[i] = age < 0 ? 0 : Math.max(0, 1 - age / 9); }
    this.alpha.needsUpdate = true;
  }
}

/* ============================================================
   Brick Racers: renderer, lobby, players (phones, keyboards, AI), split screen and HUD.
   ============================================================ */
import * as THREE from 'three';
import { Track } from './track.js';
import { Race, PU, AI_NAMES } from './race.js';
import { PLAYER_COLORS, basic } from './models.js';
import { PadHost } from './padhost.js';
import { Snd } from './audio.js';

const $ = s => document.querySelector(s);
const store = { get(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} } };
const QS = new URLSearchParams(location.search);
const opts = {
  laps: Math.max(1, Math.min(9, +store.get('br-laps') || 3)), ai: store.get('br-ai') !== '0',
  q: QS.get('q') || store.get('br-q') || 'high', rend: QS.has('webgl') ? 'webgl' : store.get('br-rend') || 'auto',
};
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const ordHtml = n => n + '<sup>' + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th') + '</sup>';
const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); };

let renderer, scene, track, race = null, demo = null, state = 'loading', overview, demoCam, demoIdx = 0, demoT = 0;
const slots = new Array(5).fill(null);
const pads = new PadHost();
const keys = new Set();
window.BR = { slots, pads, get race(){ return race; }, get state(){ return state; } }; // handy for debugging

/* ---------- boot ---------- */
async function boot(){
  const sess = { get(k){ try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set(k, v){ try { sessionStorage.setItem(k, v); } catch (e) {} } };
  const gpuFailed = !!sess.get('br-gpufail');
  renderer = new THREE.WebGPURenderer({ canvas:$('#gl'), antialias:true, forceWebGL: opts.rend === 'webgl' || gpuFailed });
  await renderer.init();
  // some GPUs and drivers offer WebGPU but lose the device or reject buffers: fall back to WebGL 2 for this session
  if (renderer.backend.isWebGPUBackend){
    let errs = 0;
    const fallback = () => { if (sess.get('br-gpufail')) return; sess.set('br-gpufail', '1'); location.reload(); };
    const dev = renderer.backend.device; if (dev && dev.lost) dev.lost.then(i => { if (i.reason !== 'destroyed') fallback(); });
    addEventListener('error', e => { if (/GPU|popErrorScope|WebGPU/i.test(e.message || '') && ++errs > 3) fallback(); });
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, opts.q === 'low' ? 1 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NoToneMapping;
  const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
  $('#badge').textContent = backend + ' · three.js r' + THREE.REVISION;
  $('#orend').textContent = opts.rend === 'webgl' ? 'WebGL' : 'Auto (' + backend + ')';
  if (gpuFailed && opts.rend !== 'webgl') $('#badge').textContent += ' (WebGPU failed on this device)';

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fd4ff');
  scene.fog = new THREE.Fog('#bfe6ff', 160, 720);
  scene.add(new THREE.HemisphereLight('#e8f4ff', '#6aa04a', 1.6));
  const sun = new THREE.DirectionalLight('#fff3d6', 2.6); sun.position.set(120, 220, 90); scene.add(sun);

  track = new Track(); track.build(scene, opts.q);
  // overview camera for the spare split-screen cell: the whole island from above
  overview = new THREE.PerspectiveCamera(42, 1, 10, 2000); overview.position.set(0, 430, 90); overview.lookAt(0, 0, -100); overview.layers.enable(1);
  demoCam = new THREE.PerspectiveCamera(60, 1, .3, 2000);

  addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight));
  setupInput(); setupLobby();
  pads.onJoin = phoneJoin; pads.onLeave = phoneLeave; pads.onButton = (p, b) => { const s = slots.find(s => s && s.key === p.key); if (s) button(s, b); };
  pads.onStatus = renderPadStatus;
  pads.start();
  toLobby();
  $('#loading').style.display = 'none';
  let last = performance.now();
  renderer.setAnimationLoop(() => { const now = performance.now(), dt = Math.min(.05, (now - last) / 1000); last = now; frame(dt); });
}

/* ---------- players ---------- */
function mkSlot(i, kind){
  const s = { i, kind, name:'P' + (i + 1), color:PLAYER_COLORS[i], key:null, phone:null, kb:-1, connected:true, input:{ steer:0, gas:0, brake:0 } };
  s.notify = e => { if (s.kind === 'phone' && s.key) pads.send(Object.assign({ t:'ev' }, e), s.key); if (e.e === 'hit') viewFlash(s); };
  return s;
}
function phoneJoin(p){
  let s = slots.find(s => s && s.key === p.key);
  if (!s){ const i = slots.findIndex(x => !x); if (i < 0) return false; s = slots[i] = mkSlot(i, 'phone'); s.key = p.key; Snd.play('join'); }
  s.phone = p; s.connected = true; s.name = p.name; p.slot = s.i;
  pads.send({ t:'slot', i:s.i, col:s.color, name:p.name }, p.key);
  renderSlots(); return true;
}
function phoneLeave(p){
  const s = slots.find(s => s && s.key === p.key); if (!s) return;
  if (state === 'lobby' || state === 'results'){ slots[s.i] = null; Snd.play('leave'); }
  else { s.connected = false; s.phone = null; s.input.steer = s.input.gas = s.input.brake = 0; }
  renderSlots();
}
function addKeyboard(){
  const used = slots.filter(s => s && s.kind === 'kb').map(s => s.kb), kb = [0, 1].find(n => !used.includes(n));
  const i = slots.findIndex(x => !x); if (kb == null || i < 0) return;
  const s = slots[i] = mkSlot(i, 'kb'); s.kb = kb; s.name = 'Keys ' + (kb + 1); Snd.play('join'); renderSlots();
}
const kartOf = s => race && race.karts.find(k => k.pl.slot === s.i && k.pl.kind !== 'ai');
function button(s, b){
  const k = kartOf(s);
  if (b === 'fire' && state === 'race' && k) race.use(k);
  if (b === 'look' && k) k.look = 1.2;
  if (b === 'start'){ if (state === 'lobby' || state === 'results') startRace(); else if (state === 'pause') resume(); }
}

/* ---------- keyboard ---------- */
const KB = [
  { l:['ArrowLeft'], r:['ArrowRight'], g:['ArrowUp'], b:['ArrowDown'], f:['Space'], look:['ShiftLeft', 'ShiftRight'] },
  { l:['KeyA'], r:['KeyD'], g:['KeyW'], b:['KeyS'], f:['KeyF'], look:['KeyR'] },
];
function setupInput(){
  addEventListener('keydown', e => {
    if (e.target && e.target.tagName === 'INPUT') return;
    Snd.init();
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    for (const s of slots) if (s && s.kind === 'kb' && KB[s.kb].f.includes(e.code)) button(s, 'fire');
    if (e.code === 'Enter'){ if (state === 'lobby' || state === 'results') startRace(); else if (state === 'pause') resume(); }
    if (e.code === 'Escape' || e.code === 'KeyP'){ if (state === 'race') pause(); else if (state === 'pause') resume(); }
    if (e.code === 'KeyM'){ Snd.toggleMusic(); renderOpts(); }
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  addEventListener('pointerdown', () => Snd.init(), { once:true });
}
const down = list => list.some(c => keys.has(c));
function readInputs(){
  for (const s of slots){
    if (!s) continue;
    if (s.kind === 'kb'){ const m = KB[s.kb]; s.input.steer = (down(m.r) ? 1 : 0) - (down(m.l) ? 1 : 0); s.input.gas = down(m.g) ? 1 : 0; s.input.brake = down(m.b) ? 1 : 0;
      const k = kartOf(s); if (k && down(m.look)) k.look = Math.max(k.look, .12); }
    else if (s.phone){ s.input.steer = s.phone.steer; s.input.gas = s.phone.gas; s.input.brake = s.phone.brake; s.name = s.phone.name; }
  }
}

/* ---------- lobby ---------- */
function setupLobby(){
  $('#addkb').onclick = () => { Snd.play('select'); addKeyboard(); };
  $('#start').onclick = () => startRace();
  $('#newcode').onclick = () => { Snd.play('select'); pads.newRoom(); renderSlots(); };
  $('#again').onclick = () => startRace();
  $('#tolobby').onclick = () => { Snd.play('back'); toLobby(); };
  $('#resume').onclick = () => resume();
  $('#quit').onclick = () => { Snd.play('back'); toLobby(); };
  document.querySelectorAll('[data-o]').forEach(b => b.onclick = () => {
    const o = b.dataset.o; Snd.play('nav');
    if (o === 'laps-') opts.laps = Math.max(1, opts.laps - 1);
    if (o === 'laps+') opts.laps = Math.min(9, opts.laps + 1);
    if (o === 'ai') opts.ai = !opts.ai;
    if (o === 'q'){ opts.q = opts.q === 'high' ? 'low' : 'high'; renderer.setPixelRatio(Math.min(devicePixelRatio || 1, opts.q === 'low' ? 1 : 1.75)); renderer.setSize(innerWidth, innerHeight); }
    if (o === 'rend'){ opts.rend = opts.rend === 'webgl' ? 'auto' : 'webgl'; store.set('br-rend', opts.rend); location.reload(); return; }
    if (o === 'mus') Snd.toggleMusic();
    if (o === 'snd') Snd.toggleSound();
    store.set('br-laps', opts.laps); store.set('br-ai', opts.ai ? '1' : '0'); store.set('br-q', opts.q);
    renderOpts();
  });
  renderOpts(); renderSlots();
}
function renderOpts(){
  $('#olaps').textContent = opts.laps; $('#oai').textContent = opts.ai ? 'On' : 'Off'; $('#oq').textContent = opts.q === 'high' ? 'High' : 'Low';
  $('#omus').textContent = Snd.musicOn ? 'On' : 'Off'; $('#osnd').textContent = Snd.soundOn ? 'On' : 'Off';
}
function renderSlots(){
  const el = $('#slots'); el.innerHTML = '';
  slots.forEach((s, i) => {
    const d = document.createElement('div'); d.className = 'slot' + (s ? ' on' : ''); d.style.setProperty('--c', PLAYER_COLORS[i]);
    const bk = document.createElement('div'); bk.className = 'bk'; d.append(bk);
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = s ? s.name : 'P' + (i + 1); d.append(nm);
    const how = document.createElement('div'); how.className = 'how';
    how.textContent = !s ? (opts.ai ? 'AI racer' : 'open') : s.kind === 'kb' ? (s.kb ? 'WASD + F' : 'Arrows + Space') : s.connected ? (s.phone && s.phone.direct ? 'phone · direct' : 'phone') : 'phone (reconnecting)';
    d.append(how);
    if (s){ const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove';
      x.onclick = () => { Snd.play('back'); if (s.kind === 'phone' && s.key) pads.drop(s.key); slots[i] = null; renderSlots(); }; d.append(x); }
    el.append(d);
  });
  $('#start').disabled = !slots.some(s => s);
}
function renderPadStatus(s, msg){
  const st = $('#padst');
  st.className = s === 'error' ? 'err' : s === 'waiting' ? 'ok' : '';
  st.textContent = msg || { loading:'Setting up the phone link…', waiting:'Ready: scan the code to join', error:'Phone link unavailable' }[s] || '';
  $('#code').textContent = pads.code || '····';
  const svg = pads.qrSvg(), q = $('#qr');
  if (svg && q.dataset.u !== pads.url){ q.innerHTML = svg; q.dataset.u = pads.url; }
  else if (!svg && pads.code && !pads.url) q.textContent = 'Open the game from its web address to get a scannable code.';
  $('#padurl').textContent = pads.url ? pads.url.replace(/^https?:\/\//, '') : '';
  renderSlots();
}

/* ---------- flow ---------- */
function toLobby(){
  state = 'lobby';
  if (race){ race.dispose(); race = null; }
  // drop phones that went away during the race
  slots.forEach((s, i) => { if (s && !s.connected) slots[i] = null; });
  ['#results', '#pause', '#hud', '#timer'].forEach(s => $(s).classList.add('hidden'));
  $('#lobby').classList.remove('hidden');
  startDemo(); renderSlots(); Snd.music(true);
}
function startDemo(){
  if (demo) demo.dispose();
  demo = new Race(scene, track, PLAYER_COLORS.map((c, i) => ({ slot:i, kind:'ai', name:AI_NAMES[i], color:c, input:{}, notify(){} })), 99);
  demo.count = .7; demoT = 0;
}
function startRace(){
  if (!slots.some(s => s && s.connected)){ big('Join first!', true); return; }
  Snd.init(); Snd.play('select');
  if (demo){ demo.dispose(); demo = null; }
  if (race) race.dispose();
  const players = [];
  slots.forEach((s, i) => {
    if (s && s.connected) players.push({ slot:i, kind:s.kind, name:s.name, color:s.color, input:s.input, notify:s.notify });
    else if (opts.ai) players.push({ slot:i, kind:'ai', name:AI_NAMES[i], color:PLAYER_COLORS[i], input:{}, notify(){} });
  });
  // shuffle the starting grid
  for (let i = players.length - 1; i > 0; i--){ const j = Math.random() * (i + 1) | 0; [players[i], players[j]] = [players[j], players[i]]; }
  race = new Race(scene, track, players, opts.laps);
  // markers above each kart for the overview camera only
  for (const k of race.karts){ const m = new THREE.Mesh(new THREE.ConeGeometry(7, 14, 4).rotateX(Math.PI), basic(k.pl.color)); m.position.y = 18; m.layers.set(1); k.mesh.add(m); }
  race.onEvent = e => {
    pads.send(Object.assign({ t:'ev' }, e));
    if (e.e === 'count') big(e.n); if (e.e === 'go') big('GO!');
    if (e.e === 'flash') gflash(e.col);
  };
  state = 'race';
  ['#results', '#pause', '#lobby'].forEach(s => $(s).classList.add('hidden'));
  $('#hud').classList.remove('hidden'); $('#timer').classList.remove('hidden');
  buildHud(); Snd.music(true);
}
function pause(){ state = 'pause'; $('#pause').classList.remove('hidden'); Snd.play('back'); }
function resume(){ state = 'race'; $('#pause').classList.add('hidden'); Snd.play('select'); }
function showResults(){
  state = 'results';
  const tb = $('#restab'); tb.innerHTML = '';
  for (const r of race.results()){
    const tr = document.createElement('tr'); if (r.kind === 'ai') tr.className = 'ai';
    const a = document.createElement('td'); a.textContent = ord(r.place);
    const b = document.createElement('td'); const i = document.createElement('i'); i.style.setProperty('--c', r.color); b.append(i, r.name + (r.kind === 'ai' ? ' (AI)' : ''));
    const c = document.createElement('td'); c.textContent = r.fin ? fmt(r.time) : '—';
    tr.append(a, b, c); tb.append(tr);
  }
  $('#results').classList.remove('hidden');
}

/* ---------- HUD ---------- */
function layout(n){
  if (n <= 1) return { views:[[0, 0, 1, 1]], spare:null };
  if (n === 2) return { views:[[0, 0, .5, 1], [.5, 0, .5, 1]], spare:null };
  if (n <= 4) return { views:[[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]].slice(0, n), spare: n === 3 ? [.5, .5, .5, .5] : null };
  const t = 1 / 3; return { views:[[0, 0, t, .5], [t, 0, t, .5], [2 * t, 0, t, .5], [0, .5, t, .5], [t, .5, t, .5]], spare:[2 * t, .5, t, .5] };
}
let hud = [], mini = null, standings = null;
function buildHud(){
  const el = $('#hud'); el.innerHTML = ''; hud = [];
  const humans = race.karts.filter(k => k.pl.kind !== 'ai'), L = layout(humans.length);
  humans.forEach((k, i) => {
    const [x, y, w, h] = L.views[i], v = document.createElement('div'); v.className = 'view';
    Object.assign(v.style, { left:x * 100 + '%', top:y * 100 + '%', width:w * 100 + '%', height:h * 100 + '%' });
    v.innerHTML = `<div class="flash"></div><div class="pos"></div><div class="lap"></div><div class="tag"><i></i><span></span></div><div class="pu"><div class="bk"></div><div class="pips"><i></i><i></i><i></i></div><span></span></div><div class="wrong hidden">WRONG WAY!</div><div class="done hidden"></div>`;
    v.style.setProperty('--c', k.pl.color); v.querySelector('.tag span').textContent = k.pl.name;
    el.append(v); hud.push({ k, v, pos:v.querySelector('.pos'), lap:v.querySelector('.lap'), pu:v.querySelector('.pu'), wrong:v.querySelector('.wrong'), done:v.querySelector('.done'), flash:v.querySelector('.flash'), cache:{} });
  });
  mini = document.createElement('canvas'); mini.id = 'mini'; el.append(mini);
  standings = null;
  const sz = Math.min(innerWidth, innerHeight);
  if (L.spare){
    const [x, y, w, h] = L.spare;
    standings = document.createElement('div'); standings.id = 'standings'; Object.assign(standings.style, { left:(x * 100 + 1.5) + '%', top:(y * 100 + 2) + '%' }); el.append(standings);
    mini.style.display = 'none';
  } else {
    const s = humans.length === 1 ? sz * .26 : sz * .22;
    Object.assign(mini.style, humans.length === 1 ? { right:'14px', top:'50%', width:s + 'px', height:s + 'px', transform:'translateY(-50%)' }
      : humans.length === 2 ? { left:'50%', bottom:'8px', width:s + 'px', height:s + 'px', transform:'translateX(-50%)' }
      : { left:'50%', top:'50%', width:s + 'px', height:s + 'px', transform:'translate(-50%,-50%)' });
  }
  mapBounds();
}
let mb = null;
function mapBounds(){
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const p of track.P){ x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  mb = { x0, z0, s: Math.max(x1 - x0, z1 - z0), cx:(x0 + x1) / 2, cz:(z0 + z1) / 2 };
}
function drawMini(){
  if (!mini || mini.style.display === 'none') return;
  const dpr = Math.min(2, devicePixelRatio || 1), S = mini.clientWidth, px = Math.round(S * dpr);
  if (mini.width !== px){ mini.width = mini.height = px; }
  const g = mini.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, S, S);
  const pad = 12, k = (S - pad * 2) / mb.s, P = (x, z) => [S / 2 + (x - mb.cx) * k, S / 2 + (z - mb.cz) * k];
  g.lineJoin = 'round'; g.lineCap = 'round';
  const path = () => { g.beginPath(); track.P.forEach((p, i) => { if (i % 4) return; const [a, b] = P(p.x, p.z); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); };
  path(); g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 9; g.stroke();
  path(); g.strokeStyle = '#fff'; g.lineWidth = 5; g.stroke();
  const [sx, sy] = P(track.P[4].x, track.P[4].z); g.fillStyle = '#111'; g.fillRect(sx - 4, sy - 4, 8, 8);
  for (const kk of [...race.karts].reverse()){ const [a, b] = P(kk.x, kk.z); g.fillStyle = kk.pl.color; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(a, b, kk.pl.kind === 'ai' ? 4 : 6, 0, 7); g.fill(); g.stroke(); }
}
function updateHud(){
  for (const h of hud){
    const k = h.k, c = h.cache, lap = Math.min(race.laps, Math.max(1, k.lapDone + 1));
    if (c.place !== k.place){ c.place = k.place; h.pos.innerHTML = ordHtml(k.place); }
    const lt = `LAP ${lap}/${race.laps}`; if (c.lap !== lt){ c.lap = lt; h.lap.textContent = lt; }
    const pk = (k.pu || '') + k.w;
    if (c.pk !== pk){ c.pk = pk; const p = k.pu && PU[k.pu];
      h.pu.style.setProperty('--bc', p ? p.col : k.w ? '#f4f4f4' : '#444'); h.pu.classList.toggle('empty', !p && !k.w);
      h.pu.querySelectorAll('.pips i').forEach((e, i) => e.classList.toggle('on', i < k.w));
      h.pu.querySelector('span').textContent = p ? p.names[k.w] : k.w ? 'add a colour brick' : 'no brick'; }
    h.wrong.classList.toggle('hidden', !k.wrong);
    if (k.fin && !c.fin){ c.fin = true; h.done.textContent = ord(k.place) + '!  ' + fmt(k.finT); h.done.classList.remove('hidden'); }
  }
  if (standings){
    const html = race.order.map(k => `<div style="--c:${k.pl.color}"><b>${k.place}</b><i></i>${k.pl.name.replace(/</g, '&lt;')}</div>`).join('');
    if (standings.dataset.h !== html){ standings.dataset.h = html; standings.innerHTML = html; }
  }
  $('#timer').textContent = fmt(race.raceTime);
  drawMini();
}
function viewFlash(s){ const h = hud.find(h => h.k.pl.slot === s.i); if (!h) return; const f = h.flash; f.style.transition = 'none'; f.style.opacity = .45; void f.offsetWidth; f.style.transition = 'opacity .5s'; f.style.opacity = 0; }
function gflash(col){ const f = $('#gflash'); f.style.background = col; f.style.transition = 'none'; f.style.opacity = .6; void f.offsetWidth; f.style.transition = 'opacity .6s'; f.style.opacity = 0; }
function big(t, small){ const b = $('#big'); b.textContent = t; b.style.fontSize = small ? 'clamp(40px,9vmin,110px)' : ''; b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }

/* ---------- phone status feed ---------- */
let feedT = 0;
function feed(dt){
  feedT -= dt; if (feedT > 0) return; feedT = .2;
  for (const s of slots){
    if (!s || s.kind !== 'phone' || !s.key || !s.connected) continue;
    const k = kartOf(s);
    if (!k || state === 'lobby'){ pads.send({ t:'st', state:'lobby' }, s.key); continue; }
    const st = state === 'pause' ? 'pause' : state === 'results' ? 'results' : race.state === 'countdown' ? 'countdown' : 'race';
    pads.send({ t:'st', state:st, pos:k.place, lap:Math.max(1, k.lapDone + 1), laps:race.laps, pu:k.pu, w:k.w, fin:k.fin }, s.key);
  }
}

/* ---------- frame ---------- */
const view = (cam, x, y, w, h) => {
  const W = innerWidth, H = innerHeight, px = Math.floor(x * W), py = Math.floor(y * H), pw = Math.ceil(w * W), ph = Math.ceil(h * H);
  renderer.setViewport(px, py, pw, ph); renderer.setScissor(px, py, pw, ph);
  if (cam.isPerspectiveCamera){ const a = pw / ph; if (Math.abs(cam.aspect - a) > 1e-3){ cam.aspect = a; cam.updateProjectionMatrix(); } }
  renderer.render(scene, cam);
};
function frame(dt){
  pads.tick(); readInputs(); feed(dt);
  if (state === 'lobby' && demo){
    demo.update(dt); demoT += dt;
    if (demoT > 9){ demoT = 0; demoIdx = (demoIdx + 1) % demo.karts.length; }
    if (demo.time > 150) startDemo();
    const k = demo.order ? demo.order[demoIdx % demo.karts.length] : demo.karts[0];
    // a slow cinematic camera: high and to the side of the kart
    const f = new THREE.Vector3(Math.sin(k.h), 0, Math.cos(k.h)), r = new THREE.Vector3(-f.z, 0, f.x), a = demoT / 9;
    const want = new THREE.Vector3(k.x, k.y, k.z).addScaledVector(f, -14 + a * 4).addScaledVector(r, 8 - a * 10).add(new THREE.Vector3(0, 6 + Math.sin(a * 3) * 2, 0));
    demoCam.position.lerp(want, demoT < .05 ? 1 : 1 - Math.exp(-dt * 3)); demoCam.lookAt(k.x, k.y + 1.5, k.z);
    Snd.engine(0, false);
    renderer.setScissorTest(false); view(demoCam, 0, 0, 1, 1);
    return;
  }
  if (!race) return;
  if (state === 'race'){ race.update(dt); if (race.state === 'done') showResults(); }
  else if (state === 'results') race.update(dt); // karts cruise on behind the results
  const humans = race.karts.filter(k => k.pl.kind !== 'ai');
  const sp = humans.length ? Math.max(...humans.map(k => Math.abs(k.speed))) / 40 : 0;
  Snd.engine(sp, state === 'race' || state === 'results');
  updateHud();
  const L = layout(humans.length);
  renderer.setScissorTest(true);
  humans.forEach((k, i) => view(k.cam, ...L.views[i]));
  if (L.spare){ const fog = scene.fog; scene.fog = null; view(overview, ...L.spare); scene.fog = fog; }
  renderer.setScissorTest(false);
}

boot().catch(e => { console.error(e); const el = $('#loading .err'); if (el) el.textContent = 'Could not start the 3D renderer: ' + (e && e.message || e) + '. Try another browser, or add ?webgl to the address.'; });

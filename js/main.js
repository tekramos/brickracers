/* ============================================================
   TekRacers: renderer, lobby, players (phones, keyboards, AI, online), split screen and HUD.
   Two ways to play together, mixed freely in one race:
   - same screen: phones or keyboards, and the screen splits between those players
   - online: friends open index.html?join=CODE on their own device and see their own kart full
     screen (split only if two of them share that device). This browser is the host.
   ============================================================ */
import * as THREE from 'three';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { Track } from './track.js';
import { Race, PU, AI_NAMES } from './race.js';
import { PLAYER_COLORS } from './models.js';
import { L as LOOK, PRESETS, setPreset, setFogRange, fogColor, makeSun, emissive } from './look.js';
import { PadHost } from './padhost.js';
import { NetHost, NetClient } from './net.js';
import { Snd } from './audio.js';

const $ = s => document.querySelector(s);
const store = { get(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} } };
const QS = new URLSearchParams(location.search);
const opts = {
  laps: Math.max(1, Math.min(9, +store.get('br-laps') || 3)), ai: store.get('br-ai') !== '0',
  q: QS.get('q') || store.get('br-q') || (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'low' : 'high'), rend: QS.has('webgl') ? 'webgl' : store.get('br-rend') || 'auto',
  cam: QS.get('cam') || store.get('br-cam') || 'chase', tod: QS.get('tod') || store.get('br-tod') || 'dusk',
};
const TODS = ['day', 'dusk', 'night', 'dawn', 'cycle'], TOD_NAMES = { day:'Day', dusk:'Sunset', night:'Night', dawn:'Dawn', cycle:'Cycle' };
Race.defaultCam = Race.CAMS.includes(opts.cam) ? opts.cam : 'chase';
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const ordHtml = n => n + '<sup>' + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th') + '</sup>';
const JOIN = (QS.get('join') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); // set on a joining device
const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); };

let renderer, scene, track, race = null, demo = null, state = 'loading', overview, demoCam, demoIdx = 0, demoT = 0, sun, post = null, scenePass = null, todT = 0, demoYaw = 0, demoSnap = true;
const slots = new Array(5).fill(null);
const pads = new PadHost();
const net = new NetHost();      // host: devices joining online
let client = null;              // joining device: the link to the host
let netEvents = [], netEvId = 0, snapT = 0, raceId = 0, grid = [];
const keys = new Set();
window.BR = { slots, pads, net, get client(){ return client; }, get race(){ return race; }, get track(){ return track; }, get state(){ return state; } }; // handy for debugging

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
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
  $('#badge').textContent = backend + ' · three.js r' + THREE.REVISION;
  $('#orend').textContent = opts.rend === 'webgl' ? 'WebGL' : 'Auto (' + backend + ')';
  if (gpuFailed && opts.rend !== 'webgl') $('#badge').textContent += ' (WebGPU failed on this device)';

  // the sky is the same colour gradient the fog fades to; one warm key light makes every shadow
  scene = new THREE.Scene();
  scene.backgroundNode = fogColor;
  setPreset(opts.tod === 'cycle' ? 'day' : opts.tod);
  track = new Track(); track.build(scene, opts.q);
  sun = makeSun(scene, opts.q);
  // overview camera for the spare split-screen cell: the whole park from above
  mapBounds();
  overview = new THREE.PerspectiveCamera(34, 1, 20, 3000); overview.layers.enable(1);
  overview.position.set(mb.cx, mb.s * 1.45, mb.cz + mb.s * .62); overview.lookAt(mb.cx, 0, mb.cz + mb.s * .05);
  demoCam = new THREE.PerspectiveCamera(30, 1, 1, 1600);
  setupPost();

  addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight));
  // build every material once behind the loading screen so the first frames don't stutter
  try { await renderer.compileAsync(scene, demoCam); } catch (e) {}
  setupInput();
  if (JOIN) setupJoin();
  else {
    setupLobby();
    pads.onJoin = phoneJoin; pads.onLeave = phoneLeave; pads.onButton = (p, b) => { const s = slots.find(s => s && s.key === p.key); if (s) button(s, b); };
    pads.onStatus = (st, msg) => { if (st === 'waiting' && net.code !== pads.code) net.start(pads.code, pads.broker); renderPadStatus(st, msg); };
    net.onJoin = netJoin; net.onLeave = netLeave; net.onChange = renderSlots;
    net.onButton = (d, i, b) => { const s = slots.find(s => s && s.devKey === d.key && s.pi === i); if (s) button(s, b); };
    pads.start();
    toLobby();
  }
  $('#loading').style.display = 'none';
  let last = performance.now();
  renderer.setAnimationLoop(() => { const now = performance.now(), dt = Math.min(.05, (now - last) / 1000); last = now; frame(dt); });
}

const pixelRatio = () => Math.min(devicePixelRatio || 1, opts.q === 'low' ? 1 : 1.5);
// bloom on the bright lights (one full-screen view only; split screens draw straight to the screen)
function setupPost(){
  if (opts.q === 'low' || !THREE.RenderPipeline){ post = null; return; }
  post = new THREE.RenderPipeline(renderer);
  scenePass = pass(scene, demoCam);
  const col = scenePass.getTextureNode('output'), b = bloom(col);
  b.threshold.value = 1; b.strength.value = .28; b.smoothWidth.value = 1; b._nMips = 3;
  post.outputNode = col.add(b);
}
// time of day: a fixed preset, or a slow cycle through all four
const CYCLE = ['day', 'dusk', 'night', 'dawn'], CYCLE_T = 60;
function updateTod(dt){
  LOOK.time.value += dt;
  if (opts.tod !== 'cycle') return;
  todT = (todT + dt) % (CYCLE_T * 4);
  const i = Math.floor(todT / CYCLE_T), f = todT / CYCLE_T - i, blend = THREE.MathUtils.smoothstep(f, .7, 1);
  setPreset(CYCLE[i], CYCLE[(i + 1) % 4], blend);
}

/* ---------- players ---------- */
function mkSlot(i, kind){
  const s = { i, kind, name:'P' + (i + 1), color:PLAYER_COLORS[i], key:null, phone:null, kb:-1, connected:true, input:{ steer:0, gas:0, brake:0 } };
  s.notify = e => {
    if (s.kind === 'phone' && s.key) pads.send(Object.assign({ t:'ev' }, e), s.key);
    if (s.kind === 'net') netEvent(['e', e, s.i]);
    if (e.e === 'hit') viewFlash(s);
  };
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
// a device joining online brings one or two players
function netJoin(d){
  const got = [];
  d.names.forEach((n, pi) => {
    let s = slots.find(s => s && s.devKey === d.key && s.pi === pi);
    if (!s){ const i = slots.findIndex(x => !x); if (i < 0) return; s = slots[i] = mkSlot(i, 'net'); s.devKey = d.key; s.pi = pi; }
    s.dev = d; s.name = n; s.connected = true; got.push(s.i);
  });
  if (got.length){ Snd.play('join'); renderSlots(); }
  return got;
}
function netLeave(d){
  for (const s of slots) if (s && s.devKey === d.key){
    if (state === 'lobby' || state === 'results') slots[s.i] = null;
    else { s.connected = false; s.dev = null; s.input.steer = s.input.gas = s.input.brake = 0; }
  }
  Snd.play('leave'); renderSlots();
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
  if (b === 'cam' && k) camToast(k, race.nextCam(k));
  if (b === 'start'){ if (state === 'lobby' || state === 'results') startRace(); else if (state === 'pause') resume(); }
}

/* ---------- keyboard ---------- */
const KB = [
  { l:['ArrowLeft'], r:['ArrowRight'], g:['ArrowUp'], b:['ArrowDown'], f:['Space'], look:['ShiftLeft', 'ShiftRight'], cam:['KeyC'] },
  { l:['KeyA'], r:['KeyD'], g:['KeyW'], b:['KeyS'], f:['KeyF'], look:['KeyR'], cam:['KeyV'] },
];
function setupInput(){
  addEventListener('keydown', e => {
    if (e.target && e.target.tagName === 'INPUT') return;
    Snd.init();
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    for (const s of slots) if (s && s.kind === 'kb' && KB[s.kb].f.includes(e.code)) button(s, 'fire');
    if (JOIN){ if (e.code === 'Enter' && client) localPress(0, 1); if (['Space', 'KeyF'].includes(e.code)) localPress(e.code === 'KeyF' && locals.length > 1 ? 1 : 0, 0);
      if (['ShiftLeft', 'ShiftRight', 'KeyR'].includes(e.code)) localPress(e.code === 'KeyR' && locals.length > 1 ? 1 : 0, 2); }
    else {
      if (e.code === 'Enter'){ if (state === 'lobby' || state === 'results') startRace(); else if (state === 'pause') resume(); }
      if (e.code === 'Escape' || e.code === 'KeyP'){ if (state === 'race') pause(); else if (state === 'pause') resume(); }
    }
    if (e.code === 'KeyM'){ Snd.toggleMusic(); renderOpts(); }
    // each player switches their own camera: C (arrows player) and V (WASD player)
    if (e.code === 'KeyC' || e.code === 'KeyV'){
      if (JOIN){ const i = e.code === 'KeyV' && locals.length > 1 ? 1 : 0, k = race && race.karts.find(k => k.local && k.pl.slot === client.slots[i]); if (k) camToast(k, race.nextCam(k)); }
      else for (const s of slots) if (s && s.kind === 'kb' && KB[s.kb].cam.includes(e.code)) button(s, 'cam');
    }
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
    else if (s.kind === 'net' && s.dev){ const p = s.dev.players[s.pi]; if (p){ s.input.steer = p.steer; s.input.gas = p.gas; s.input.brake = p.brake; } }
  }
}

/* ---------- lobby ---------- */
function setupLobby(){
  $('#addkb').onclick = () => { Snd.play('select'); addKeyboard(); };
  $('#start').onclick = () => startRace();
  $('#newcode').onclick = () => { Snd.play('select'); net.stop(); pads.newRoom(); renderSlots(); };
  $('#copyonline').onclick = async () => { Snd.play('select'); try { await navigator.clipboard.writeText(net.url); $('#copyonline').textContent = 'Copied!'; } catch (e) { prompt('Send this link to your friends:', net.url); }
    setTimeout(() => $('#copyonline').textContent = 'Copy link', 1500); };
  $('#again').onclick = () => startRace();
  $('#tolobby').onclick = () => { Snd.play('back'); toLobby(); };
  $('#resume').onclick = () => resume();
  $('#quit').onclick = () => { Snd.play('back'); toLobby(); };
  document.querySelectorAll('[data-o]').forEach(b => b.onclick = () => {
    const o = b.dataset.o; Snd.play('nav');
    if (o === 'laps-') opts.laps = Math.max(1, opts.laps - 1);
    if (o === 'laps+') opts.laps = Math.min(9, opts.laps + 1);
    if (o === 'ai') opts.ai = !opts.ai;
    if (o === 'q'){ opts.q = opts.q === 'high' ? 'low' : 'high'; store.set('br-q', opts.q); location.reload(); return; }
    if (o === 'cam'){ opts.cam = Race.CAMS[(Race.CAMS.indexOf(opts.cam) + 1) % Race.CAMS.length]; Race.defaultCam = opts.cam; }
    if (o === 'tod'){ opts.tod = TODS[(TODS.indexOf(opts.tod) + 1) % TODS.length]; if (opts.tod !== 'cycle') setPreset(opts.tod); else todT = 0; }
    if (o === 'rend'){ opts.rend = opts.rend === 'webgl' ? 'auto' : 'webgl'; store.set('br-rend', opts.rend); location.reload(); return; }
    if (o === 'mus') Snd.toggleMusic();
    if (o === 'snd') Snd.toggleSound();
    store.set('br-laps', opts.laps); store.set('br-ai', opts.ai ? '1' : '0'); store.set('br-q', opts.q); store.set('br-cam', opts.cam); store.set('br-tod', opts.tod);
    renderOpts();
  });
  renderOpts(); renderSlots();
}
function renderOpts(){
  $('#olaps').textContent = opts.laps; $('#oai').textContent = opts.ai ? 'On' : 'Off'; $('#oq').textContent = opts.q === 'high' ? 'High' : 'Low';
  $('#omus').textContent = Snd.musicOn ? 'On' : 'Off'; $('#osnd').textContent = Snd.soundOn ? 'On' : 'Off';
  $('#ocam').textContent = { chase:'Chase', high:'High', top:'Top' }[opts.cam] || 'Chase'; $('#otod').textContent = TOD_NAMES[opts.tod] || 'Sunset';
}
// a short label in the player's view when they change camera
function camToast(k, mode){
  store.set('br-cam', mode); opts.cam = Race.defaultCam = mode;
  const h = hud.find(h => h.k === k); if (!h) return;
  const t = h.cam; t.textContent = { chase:'Chase view', high:'High view', top:'Top view' }[mode]; t.style.transition = 'none'; t.style.opacity = 1; void t.offsetWidth; t.style.transition = 'opacity 1.4s .5s'; t.style.opacity = 0;
}
function renderSlots(){
  const el = $('#slots'); el.innerHTML = '';
  slots.forEach((s, i) => {
    const d = document.createElement('div'); d.className = 'slot' + (s ? ' on' : ''); d.dataset.n = String(i + 1).padStart(2, '0'); d.style.setProperty('--c', PLAYER_COLORS[i]);
    const bk = document.createElement('div'); bk.className = 'bk'; d.append(bk);
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = s ? s.name : 'P' + (i + 1); d.append(nm);
    const how = document.createElement('div'); how.className = 'how';
    how.textContent = !s ? (opts.ai ? 'AI racer' : 'open') : s.kind === 'kb' ? (s.kb ? 'WASD + F' : 'Arrows + Space')
      : s.kind === 'net' ? (s.connected ? (s.dev && s.dev.direct ? 'online · direct' : 'online') : 'online (reconnecting)')
      : s.connected ? (s.phone && s.phone.direct ? 'phone · direct' : 'phone') : 'phone (reconnecting)';
    d.append(how);
    if (s){ const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove';
      x.onclick = () => { Snd.play('back'); if (s.kind === 'phone' && s.key) pads.drop(s.key); if (s.kind === 'net') net.drop(s.devKey, true); slots[i] = null; renderSlots(); }; d.append(x); }
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
  const ou = net.url || (pads.code ? '' : '');
  $('#onlineurl').textContent = ou ? ou.replace(/^https?:\/\//, '') : (pads.code ? 'Open the game from its web address to invite friends online.' : '…');
  $('#copyonline').disabled = !ou;
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
  demo.count = .7; demoT = 0; demoSnap = true;
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
  race.log = []; raceId++; grid = players.map(p => [p.slot, p.kind === 'ai' ? 'ai' : 'p', p.name, p.color]);
  // markers above each kart for the overview camera only
  for (const k of race.karts){ const m = new THREE.Mesh(markerG, emissive(k.pl.color, 1.6)); m.position.y = 22; m.layers.set(1); k.mesh.add(m); }
  race.onEvent = e => {
    pads.send(Object.assign({ t:'ev' }, e)); netEvent(['e', e, -1]);
    if (e.e === 'count'){ big(e.n); startLights(e.n); } if (e.e === 'go'){ big('GO!'); startLights(0); }
    if (e.e === 'flash') gflash(e.col);
  };
  state = 'race';
  ['#results', '#pause', '#lobby'].forEach(s => $(s).classList.add('hidden'));
  $('#hud').classList.remove('hidden'); $('#timer').classList.remove('hidden');
  buildHud(); Snd.music(true);
}
const markerG = new THREE.ConeGeometry(9, 18, 4).rotateX(Math.PI);
function pause(){ state = 'pause'; $('#pause').classList.remove('hidden'); Snd.play('back'); }
function resume(){ state = 'race'; $('#pause').classList.add('hidden'); Snd.play('select'); }
function showResults(){ state = 'results'; showResultsList(race.results()); }
function showResultsList(list){
  const tb = $('#restab'); tb.innerHTML = '';
  for (const r of list){
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
// the karts that get a view on this screen: players sitting here (online players have their own screens)
function screenKarts(){
  if (!race) return [];
  const mine = race.client ? race.karts.filter(k => k.local) : race.karts.filter(k => race.isLocal(k));
  return mine;
}
function buildHud(){
  const el = $('#hud'); el.innerHTML = ''; hud = [];
  const humans = screenKarts(), L = humans.length ? layout(humans.length) : { views:[], spare:[0, 0, 1, 1] };
  // with a split screen the race clock sits where the views meet, clear of each view's lap box
  $('#timer').classList.toggle('mid', humans.length > 1);
  humans.forEach((k, i) => {
    const [x, y, w, h] = L.views[i], v = document.createElement('div'); v.className = 'view';
    Object.assign(v.style, { left:x * 100 + '%', top:y * 100 + '%', width:w * 100 + '%', height:h * 100 + '%' });
    v.innerHTML = `<div class="flash"></div><div class="pos"></div><div class="lap"></div><div class="tag"><i></i><span></span></div><div class="pu"><div class="bk"></div><div class="pips"><i></i><i></i><i></i></div><span></span></div><div class="camt"></div><div class="wrong hidden">WRONG WAY!</div><div class="done hidden"></div>`;
    v.style.setProperty('--c', k.pl.color); v.querySelector('.tag span').textContent = k.pl.name;
    el.append(v); hud.push({ k, v, pos:v.querySelector('.pos'), lap:v.querySelector('.lap'), pu:v.querySelector('.pu'), wrong:v.querySelector('.wrong'), done:v.querySelector('.done'), flash:v.querySelector('.flash'), cam:v.querySelector('.camt'), cache:{} });
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
  path(); g.strokeStyle = 'rgba(40,14,58,.72)'; g.lineWidth = 10; g.stroke();
  path(); g.strokeStyle = '#ffe9d2'; g.lineWidth = 4; g.stroke();
  // the bridge in orange, the tunnel dashed
  for (const [kind, col, dash] of [['bridge', '#ff9a4e', []], ['tunnel', '#b28cff', [3, 4]]]){
    g.beginPath(); let on = false;
    track.P.forEach((p, i) => { if (i % 2) return; const [a, b] = P(p.x, p.z); if (track.kind[i] === kind){ on ? g.lineTo(a, b) : g.moveTo(a, b); on = true; } else on = false; });
    g.setLineDash(dash); g.strokeStyle = col; g.lineWidth = 4; g.stroke(); g.setLineDash([]);
  }
  const [sx, sy] = P(track.P[4].x, track.P[4].z); g.fillStyle = '#2d1640'; g.fillRect(sx - 2, sy - 6, 4, 12);
  for (const kk of [...race.karts].reverse()){ const [a, b] = P(kk.x, kk.z); g.fillStyle = kk.pl.color; g.strokeStyle = kk.pl.kind === 'ai' ? 'rgba(8,6,20,.8)' : '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(a, b, kk.pl.kind === 'ai' ? 4 : 6, 0, 7); g.fill(); g.stroke(); }
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
      h.pu.querySelector('span').textContent = p ? p.names[k.w] : k.w ? 'add a colour core' : 'no core'; }
    h.wrong.classList.toggle('hidden', !k.wrong);
    if (k.fin && !c.fin){ c.fin = true; h.done.textContent = ord(k.place) + '!  ' + fmt(k.finT); h.done.classList.remove('hidden'); }
  }
  if (standings){
    const html = race.order.map(k => `<div style="--c:${k.pl.color}"><b>${k.place}</b><i></i>${k.pl.name.replace(/</g, '&lt;')}</div>`).join('');
    if (standings.dataset.h !== html){ standings.dataset.h = html; standings.innerHTML = html; }
  }
  $('#timer').textContent = fmt(race.client ? race.clientTime : race.raceTime);
  drawMini();
}
function viewFlash(s){ const h = hud.find(h => h.k.pl.slot === s.i); if (!h) return; const f = h.flash; f.style.transition = 'none'; f.style.opacity = .45; void f.offsetWidth; f.style.transition = 'opacity .5s'; f.style.opacity = 0; }
// the gantry lights: red ones come on as the count goes down, all green on GO
let lightsN = -1;
function startLights(n){
  if (n === lightsN) return; lightsN = n;
  track.setStartLights(n);
}
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
// set the shared look for one view: what it follows (see-through cut, shadows, grass) and how far its fog reaches
const tmpV = new THREE.Vector3(), kpos = new THREE.Vector3(), noCut = new THREE.Vector3(0, -999, 0);
function prepView(cam, focus, kartPos, kind){
  LOOK.cut.value.copy(kartPos || noCut);
  const d = cam.position.distanceTo(focus);
  LOOK.cutR.value = kind === 'top' ? 12 : 7.5;
  if (kind === 'top'){ setFogRange(d * 1.05, d * 2.3); sun.aim(focus, Math.min(110, d * .95)); }
  else if (kind === 'map'){ setFogRange(5000, 6000); sun.aim(focus, 60); }
  else { setFogRange(26, 240); sun.aim(tmpV.copy(cam.position).lerp(focus, .5).setY(focus.y), 70); }
  if (kind === 'map') track.grassCenter.value.set(1e5, 1e5); else track.grassCenter.value.set(focus.x, focus.z);
}
const view = (cam, x, y, w, h, full) => {
  const W = innerWidth, H = innerHeight, px = Math.floor(x * W), py = Math.floor(y * H), pw = Math.ceil(w * W), ph = Math.ceil(h * H);
  if (cam.isPerspectiveCamera){ const a = pw / ph; if (Math.abs(cam.aspect - a) > 1e-3){ cam.aspect = a; cam.updateProjectionMatrix(); } }
  if (full && post){ scenePass.camera = cam; renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); post.render(); return; }
  renderer.setViewport(px, py, pw, ph); renderer.setScissor(px, py, pw, ph);
  renderer.render(scene, cam);
};
const kartView = k => { prepView(k.cam, k.focus, kpos.set(k.x, k.y, k.z), k.camMode === 'top' ? 'top' : 'chase'); return k.cam; };
function frame(dt){
  updateTod(dt);
  // keep the gantry lights in step with the race even if a count event was missed (joining devices)
  const lr = race || demo; if (lr) startLights(lr.state === 'countdown' ? (lightsN > 0 ? lightsN : -1) : 0);
  if (!JOIN){ pads.tick(); readInputs(); feed(dt); } else readLocal();
  if (JOIN) client && sendLocal(dt);
  else net.tick();
  if ((state === 'lobby' || JOIN && !race) && demo){
    if (!JOIN) hostSnap(dt);
    demo.update(dt); demoT += dt;
    if (demoT > 12){ demoT = 0; demoIdx = (demoIdx + 1) % demo.karts.length; demoSnap = true; }
    if (demo.time > 150) startDemo();
    const k = demo.order ? demo.order[demoIdx % demo.karts.length] : demo.karts[0];
    // a slow orbit around the kart, high up like a diorama
    demoYaw += dt * .12;
    const d = 92, el = .62, h = Math.cos(el) * d;
    const want = new THREE.Vector3(k.focus.x - Math.sin(k.h + demoYaw) * h, k.focus.y + Math.sin(el) * d, k.focus.z - Math.cos(k.h + demoYaw) * h);
    demoCam.position.lerp(want, demoSnap ? 1 : 1 - Math.exp(-dt * 1.2)); demoSnap = false; demoCam.lookAt(k.focus);
    Snd.engine(0, false);
    prepView(demoCam, k.focus, null, 'top');
    renderer.setScissorTest(false); view(demoCam, 0, 0, 1, 1, true);
    return;
  }
  if (JOIN){ joinFrame(dt); return; }
  if (!race){ hostSnap(dt); return; }
  if (state === 'race'){ race.update(dt); if (race.state === 'done') showResults(); }
  else if (state === 'results') race.update(dt); // karts cruise on behind the results
  hostSnap(dt);
  renderRace();
}
function renderRace(){
  const humans = screenKarts();
  const sp = humans.length ? Math.max(...humans.map(k => Math.abs(k.speed))) / 40 : 0;
  Snd.engine(sp, state === 'race' || state === 'results');
  updateHud();
  // nobody plays on this screen (everyone is online): watch the leader
  if (!humans.length){ const lead = (race.order || race.karts)[0]; renderer.setScissorTest(false); view(kartView(lead), 0, 0, 1, 1, true); return; }
  if (humans.length === 1){ renderer.setScissorTest(false); view(kartView(humans[0]), 0, 0, 1, 1, true); return; }
  renderer.setScissorTest(true);
  const L = layout(humans.length);
  humans.forEach((k, i) => view(kartView(k), ...L.views[i]));
  if (L.spare){ prepView(overview, tmpV.set(mb.cx, 0, mb.cz), null, 'map'); view(overview, ...L.spare); }
  renderer.setScissorTest(false);
}

/* ---------- online: host side ---------- */
function netEvent(d){ netEvents.push({ id:++netEvId, at:performance.now(), d }); }
// stream the race to joined devices: 20 snapshots a second (4 in the lobby)
function hostSnap(dt){
  if (!net.devices.size){ netEvents.length = 0; if (race && race.log) race.log.length = 0; return; }
  if (race && race.log){ for (const e of race.log) netEvent(e); race.log.length = 0; }
  snapT -= dt; if (snapT > 0) return; snapT = state === 'lobby' ? .25 : .05;
  const now = performance.now(); netEvents = netEvents.filter(e => now - e.at < 700);
  const roster = slots.map(s => s && [s.i, s.name, s.color, s.kind === 'net' ? 'online' : s.kind]).filter(Boolean);
  const o = { t:'snap', st:state, roster, ai:opts.ai, laps:opts.laps, ev:netEvents.map(e => [e.id, e.d]) };
  if (race && state !== 'lobby'){ Object.assign(o, race.snapshot(), { sid:raceId, grid, laps:race.laps }); if (state === 'results') o.res = race.results(); }
  net.snap(o);
}

/* ---------- online: joining device ---------- */
const locals = [];   // players on this device: { name, input, cnt:[fire,start,look] }
let lastEv = 0, joinSid = 0, sendT = 0, lastSentJ = '', lastSentT = 0, touch = null;
const PADMAP = gp => gp && { steer: Math.abs(gp.axes[0] || 0) > .15 ? gp.axes[0] : (gp.buttons[15] && gp.buttons[15].pressed ? 1 : 0) - (gp.buttons[14] && gp.buttons[14].pressed ? 1 : 0),
  gas: (gp.buttons[0] && gp.buttons[0].pressed) || (gp.buttons[7] && gp.buttons[7].value > .3) ? 1 : 0, brake: (gp.buttons[1] && gp.buttons[1].pressed) || (gp.buttons[6] && gp.buttons[6].value > .3) ? 1 : 0,
  fire: gp.buttons[2] && gp.buttons[2].pressed || gp.buttons[5] && gp.buttons[5].pressed, look: gp.buttons[3] && gp.buttons[3].pressed, start: gp.buttons[9] && gp.buttons[9].pressed };
function setupJoin(){
  $('#lobby').classList.add('hidden'); $('#joinui').classList.remove('hidden');
  $('#jcode').textContent = JOIN; $('#jcode2').textContent = JOIN; $('#jname').value = store.get('br-name') || '';
  $('#jtwo').onchange = () => $('#jname2').classList.toggle('hidden', !$('#jtwo').checked);
  $('#jgo').onclick = () => {
    const n1 = $('#jname').value.trim().slice(0, 12), n2 = $('#jname2').value.trim().slice(0, 12);
    if (!n1){ $('#jname').focus(); return; }
    store.set('br-name', n1); Snd.init(); Snd.play('select');
    const names = [n1]; if ($('#jtwo').checked) names.push(n2 || 'Player 2');
    locals.length = 0; names.forEach(n => locals.push({ name:n, input:{ steer:0, gas:0, brake:0 }, cnt:[0, 0, 0], gp:{} }));
    client = new NetClient(JOIN, names);
    client.onStatus = joinStatus; client.onSnap = onSnap;
    client.start(); $('#jform').classList.add('hidden'); $('#jwait').classList.remove('hidden'); joinStatus('connecting');
  };
  $('#jform').addEventListener('keydown', e => { if (e.key === 'Enter') $('#jgo').click(); });
  $('#jstart').onclick = () => localPress(0, 1);
  $('#again').onclick = () => localPress(0, 1);
  $('#tolobby').textContent = 'LEAVE'; $('#tolobby').onclick = () => { if (client) client.leave(); location.href = location.pathname; };
  $('#resume').onclick = () => localPress(0, 1); $('#quit').classList.add('hidden');
  if ('ontouchstart' in window) setupTouch();
  startDemo(); state = 'lobby'; Snd.music(true);
}
function joinStatus(st){
  const msg = { connecting:'Connecting to race ' + JOIN + '…', joined:'You are in! Waiting for the host to start the race.', full:'This race is full (5 players).',
    removed:'The host removed you from the race.', lost:'Lost the host. Reconnecting…', error:'Could not reach the internet.' }[st] || st;
  $('#jst').textContent = msg + (client && client.slots.length ? (client.direct ? '  (direct link' : '  (relay') + (client.ping ? ', ' + client.ping + ' ms)' : ')') : '');
}
function localPress(i, b){ const p = locals[i]; if (!p) return; p.cnt[b]++; sendT = 0; lastSentJ = ''; }
// joining device controls: keyboard (arrows or WASD), gamepads and touch buttons
function readLocal(){
  const pads2 = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  locals.forEach((p, i) => {
    const kbs = locals.length > 1 ? [KB[i]] : KB, inp = p.input;
    let steer = 0, gas = 0, brake = 0;
    for (const m of kbs){ steer += (down(m.r) ? 1 : 0) - (down(m.l) ? 1 : 0); gas = gas || down(m.g); brake = brake || down(m.b); }
    const g = PADMAP(pads2[i]);
    if (g){ steer += g.steer; gas = gas || g.gas; brake = brake || g.brake;
      for (const [k, b] of [['fire', 0], ['start', 1], ['look', 2]]){ if (g[k] && !p.gp[k]) localPress(i, b); p.gp[k] = g[k]; } }
    if (i === 0 && touch){ steer += touch.steer; gas = gas || touch.gas; brake = brake || touch.brake; }
    inp.steer = Math.max(-1, Math.min(1, steer)); inp.gas = gas ? 1 : 0; inp.brake = brake ? 1 : 0;
    const k = race && race.karts.find(k => k.local && k.pl.slot === (client.slots[i])); if (k && (kbs.some(m => down(m.look)) || g && g.look)) k.look = Math.max(k.look, .12);
  });
}
// send the inputs when they change (at most 30 a second), plus a heartbeat
function sendLocal(dt){
  sendT -= dt; if (sendT > 0) return;
  const r2 = v => Math.round(v * 100) / 100, p = locals.map(l => [r2(l.input.steer), l.input.gas, l.input.brake, l.cnt.slice()]), j = JSON.stringify(p), t = performance.now();
  if (j === lastSentJ && t - lastSentT < 150) return;
  sendT = 1 / 30; lastSentJ = j; lastSentT = t; client.input(p);
}
function onSnap(s){
  if (!client.slots.length) return;
  $('#jroster').innerHTML = '';
  for (const [i, n, c, kind] of s.roster || []){
    const d = document.createElement('div'); d.style.setProperty('--c', c); const b = document.createElement('i'); d.append(b, n + (client.slots.includes(i) ? ' (you)' : '') + ' · ' + kind); $('#jroster').append(d);
  }
  if (s.st === 'lobby' || !s.k){
    if (race){ race.dispose(); race = null; ['#hud', '#timer', '#results', '#pause', '#touch'].forEach(x => $(x).classList.add('hidden')); $('#joinui').classList.remove('hidden'); startDemo(); }
    lastEv = Math.max(lastEv, ...(s.ev || []).map(e => e[0]), 0); joinStatus(client.status); return;
  }
  // a new race: build the same grid as the host
  if (!race || s.sid !== joinSid){
    if (race) race.dispose(); if (demo){ demo.dispose(); demo = null; }
    joinSid = s.sid;
    const players = s.grid.map(([slot, kind, name, color]) => {
      const li = client.slots.indexOf(slot);
      return li >= 0 ? { slot, kind:'kb', name, color, input:locals[li].input, notify(){} } : { slot, kind: kind === 'ai' ? 'ai' : 'net', name, color, input:{}, notify(){} };
    });
    race = new Race(scene, track, players, s.laps); race.client = true;
    for (const k of race.karts){ k.local = client.slots.includes(k.pl.slot); if (k.ai) k.ai = null; }
    $('#joinui').classList.add('hidden'); $('#hud').classList.remove('hidden'); $('#timer').classList.remove('hidden');
    buildHud(); state = 'race';
  }
  race.applySnap(s, Math.min(.2, (client.ping || 60) / 2000 + .02));
  for (const [id, e] of s.ev || []){
    if (id <= lastEv) continue; lastEv = id;
    if (e[0] === 's'){ const mine = client.slots.includes(e[2]); if (e[2] === -1 || mine && e[1] !== 'bump') Snd.play(e[1]); }
    else if (e[0] === 'e'){ const ev = e[1], mine = e[2] === -1 || client.slots.includes(e[2]); if (!mine) continue;
      if (ev.e === 'count'){ big(ev.n); startLights(ev.n); } if (ev.e === 'go'){ big('GO!'); startLights(0); } if (ev.e === 'flash') gflash(ev.col);
      if (ev.e === 'hit') viewFlash({ i:e[2] }); }
    else race.replay(e);
  }
  $('#pause').classList.toggle('hidden', s.st !== 'pause');
  if (s.st === 'results' && s.res && state !== 'results'){ state = 'results'; showResultsList(s.res); }
  if (s.st !== 'results' && state === 'results'){ state = 'race'; $('#results').classList.add('hidden'); }
}
function joinFrame(dt){
  if (!race){ return; }
  race.clientUpdate(dt);
  if (touch) $('#touch').classList.remove('hidden');
  renderRace();
}
function setupTouch(){
  touch = { steer:0, gas:0, brake:0 };
  const hold = (id, f) => { const b = $(id);
    b.addEventListener('touchstart', e => { e.preventDefault(); b.classList.add('on'); f(1); }, { passive:false });
    const up = e => { e.preventDefault(); b.classList.remove('on'); f(0); }; b.addEventListener('touchend', up); b.addEventListener('touchcancel', up); };
  hold('#tl', v => touch.steer = v ? -1 : 0); hold('#tr', v => touch.steer = v ? 1 : 0);
  hold('#tgas', v => touch.gas = v); hold('#tbrake', v => touch.brake = v);
  hold('#tfire', v => { if (v) localPress(0, 0); });
  hold('#tcam', v => { if (v){ const k = race && race.karts.find(k => k.local && k.pl.slot === client.slots[0]); if (k) camToast(k, race.nextCam(k)); } });
}

boot().catch(e => { console.error(e); const el = $('#loading .err'); if (el) el.textContent = 'Could not start the 3D renderer: ' + (e && e.message || e) + '. Try another browser, or add ?webgl to the address.'; });

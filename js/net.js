/* ============================================================
   Online races: friends play from their own devices at home.
   The host's browser runs the race (it is the server); each joining device opens
   index.html?join=CODE, sends its players' inputs and draws the race from the snapshots the
   host streams back about 20 times a second.
   The link is the same as the phone controller: a public MQTT broker as relay (any network),
   then a direct WebRTC data channel per device negotiated through it. Topics:
     <room>/net/up    devices -> host (hello, inputs, offers, pings)
     <room>/net/down  host -> devices (join answers, WebRTC answers, pongs), addressed with `to`
     <room>/net/snap  host -> devices still on the relay (snapshots, 10 a second)
   No server of our own is needed.
   ============================================================ */
import { PAD_CDN, PAD_BROKERS } from './padhost.js';

const TOPIC = 'tekracers/v1/';
const ICE = [{ urls:['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls:'stun:stun.cloudflare.com:3478' }];
const BUTTONS = ['fire', 'start', 'look', 'cam'];
const loadJs = src => new Promise((ok, bad) => {
  if ([...document.scripts].some(s => s.src === src)) return ok();
  const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Could not load ' + src)); document.head.appendChild(s);
});
const gathered = pc => new Promise(ok => { if (pc.iceGatheringState === 'complete') return ok(); const t = setTimeout(ok, 2500); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete'){ clearTimeout(t); ok(); } }); });

/* ---------- host side ---------- */
export class NetHost {
  constructor(){
    this.devices = new Map(); // key -> { key, names, players:[{steer,gas,brake,cnt}], pc, dc, direct, last, epoch, seq }
    this.mq = null; this.code = ''; this.snapN = 0;
    this.onJoin = () => []; this.onLeave = () => {}; this.onButton = () => {}; this.onChange = () => {};
  }
  async start(code, broker){
    this.stop(); this.code = code; this.broker = broker || 0;
    try { await loadJs(PAD_CDN.mqtt); } catch (e) { return; }
    const m = this.mq = window.mqtt.connect(window.PAD_BROKER_URL || PAD_BROKERS[broker || 0], { clientId:'brn-' + code + '-' + Math.random().toString(16).slice(2, 8), keepalive:20, reconnectPeriod:2000, connectTimeout:6000, clean:true });
    m.on('connect', () => m.subscribe(TOPIC + code + '/net/up', { qos:0 }));
    m.on('message', (t, buf) => { let d; try { d = JSON.parse(buf.toString()); } catch (e) { return; } this.onData(d, 'relay'); });
  }
  stop(){
    for (const k of [...this.devices.keys()]) this.drop(k, true);
    if (this.mq){ this.mq.end(true); this.mq = null; }
  }
  get url(){
    if (!this.code || !/^https?:$/.test(location.protocol) && !window.PAD_HOME) return '';
    const u = new URL('index.html', window.PAD_HOME || location.href); u.search = '?join=' + this.code; u.hash = '';
    // the joining device must use the same relay server as this host
    if (window.PAD_BROKER_URL) u.searchParams.set('bu', window.PAD_BROKER_URL); else u.searchParams.set('b', String(this.broker || 0));
    return u.href;
  }
  relay(o, sub = 'down'){ if (this.mq && this.mq.connected) this.mq.publish(TOPIC + this.code + '/net/' + sub, JSON.stringify(o), { qos:0 }); }
  send(o, key){
    const d = this.devices.get(key); o.to = key;
    if (d && d.dc && d.dc.readyState === 'open'){ try { d.dc.send(JSON.stringify(o)); return; } catch (e) {} }
    this.relay(o);
  }
  // snapshots: straight down each direct link; one relay copy (at half rate) for devices without one
  snap(o){
    this.snapN++; const j = JSON.stringify(o); let relayNeeded = false;
    for (const d of this.devices.values()){
      if (d.dc && d.dc.readyState === 'open'){ try { d.dc.send(j); continue; } catch (e) {} }
      relayNeeded = true;
    }
    if (relayNeeded && this.snapN % 2 === 0 && this.mq && this.mq.connected) this.mq.publish(TOPIC + this.code + '/net/snap', j, { qos:0 });
  }
  async onOffer(d, o){
    this.dropRtc(d); const pc = d.pc = new RTCPeerConnection({ iceServers:ICE });
    pc.ondatachannel = e => { const c = d.dc = e.channel;
      c.onopen = () => { if (d.dc === c){ d.direct = true; this.onChange(); } };
      c.onclose = () => { if (d.dc === c){ d.direct = false; d.dc = null; this.onChange(); } };
      c.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (er) { return; } m.k = d.key; this.onData(m, 'direct'); }; };
    try {
      await pc.setRemoteDescription({ type:'offer', sdp:o.sdp }); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc);
      if (d.pc === pc) this.relay({ t:'answer', to:d.key, id:o.id, sdp:pc.localDescription.sdp });
    } catch (e) {}
  }
  dropRtc(d){ if (d.dc) try { d.dc.close(); } catch (e) {} if (d.pc) try { d.pc.close(); } catch (e) {} d.dc = d.pc = null; d.direct = false; }
  onData(m, via){
    if (!m || typeof m !== 'object' || typeof m.k !== 'string' || !m.k) return;
    let d = this.devices.get(m.k);
    if (!d){
      // a device we do not know (the host reloaded): ask it to say hello again
      if (m.t !== 'hello' && m.t !== 'in'){ if (m.t !== 'bye') this.relay({ t:'who', to:m.k }); return; }
      const names = (Array.isArray(m.n) ? m.n : ['Racer']).slice(0, 2).map(n => String(n || 'Racer').trim().slice(0, 12) || 'Racer');
      d = { key:m.k, names, players:names.map(() => ({ steer:0, gas:0, brake:0, cnt:null })), pc:null, dc:null, direct:false, last:performance.now(), seq:0, epoch:null, slots:[] };
      // the game gives the device a slot per player (fewer if the race is nearly full)
      d.slots = this.onJoin(d);
      if (!d.slots.length){ this.relay({ t:'full', to:m.k }); return; }
      this.devices.set(m.k, d);
      this.send({ t:'joined', slots:d.slots }, m.k);
    }
    d.last = performance.now();
    if (m.t === 'hello'){ this.send({ t:'joined', slots:d.slots }, m.k); return; }
    if (m.t === 'offer'){ this.onOffer(d, m); return; }
    if (m.t === 'ping'){ this.send({ t:'pong', ts:m.ts }, m.k); return; }
    if (m.t === 'bye'){ this.drop(m.k); return; }
    if (m.t !== 'in') return;
    if (via === 'relay' && d.direct) return; // late relay copies never override the direct link
    if (m.e !== d.epoch){ d.epoch = m.e; d.seq = 0; d.players.forEach(p => p.cnt = null); }
    if (m.s <= d.seq) return; d.seq = m.s;
    (m.p || []).forEach((a, i) => { const p = d.players[i]; if (!p || !Array.isArray(a)) return;
      p.steer = Math.max(-1, Math.min(1, +a[0] || 0)); p.gas = +a[1] || 0; p.brake = +a[2] || 0;
      // buttons as running counters, so a lost packet never drops a press
      if (Array.isArray(a[3])){ if (!p.cnt) p.cnt = a[3].slice(); BUTTONS.forEach((b, j) => { if (a[3][j] > p.cnt[j]) this.onButton(d, i, b); }); p.cnt = a[3].slice(); } });
  }
  drop(key, tell){
    const d = this.devices.get(key); if (!d) return;
    if (tell) this.relay({ t:'bye', to:key });
    this.dropRtc(d); this.devices.delete(key); this.onLeave(d);
  }
  tick(){
    const now = performance.now();
    for (const d of [...this.devices.values()]){
      const quiet = now - d.last;
      if (quiet > 1500) d.players.forEach(p => { p.steer = p.gas = p.brake = 0; });
      if (quiet > 12000) this.drop(d.key);
    }
  }
}

/* ---------- joining device ---------- */
export class NetClient {
  constructor(code, names){
    this.code = code; this.names = names;
    let key = null; try { key = sessionStorage.getItem('br-netkey'); } catch (e) {}
    this.key = key || Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem('br-netkey', this.key); } catch (e) {}
    this.epoch = Math.random().toString(36).slice(2, 6); this.seq = 0;
    this.mq = null; this.pc = null; this.dc = null; this.rtcId = ''; this.offerT = -1e9; this.tries = 0;
    this.slots = []; this.status = 'connecting'; this.ping = 0; this.hostSeen = -1e9; this.snapT = -1e9;
    this.onSnap = () => {}; this.onStatus = () => {};
  }
  get direct(){ return !!(this.dc && this.dc.readyState === 'open'); }
  async start(){
    try { await loadJs(PAD_CDN.mqtt); } catch (e) { this.setStatus('error'); return; }
    const QS = new URLSearchParams(location.search);
    const first = QS.get('bu') ? -1 : (+QS.get('b') || 0);
    const T = TOPIC + this.code + '/net/';
    // connect to the relay the host is on; if that cannot be reached, try the others
    const open = i => {
      const url = i < 0 ? QS.get('bu') : PAD_BROKERS[i]; let ok = false;
      const m = this.mq = window.mqtt.connect(url, { clientId:'brc-' + Math.random().toString(16).slice(2, 10), keepalive:20, reconnectPeriod:2000, connectTimeout:6000, clean:true });
      m.on('connect', () => { ok = true; m.subscribe(T + 'down', { qos:0 }); m.subscribe(T + 'snap', { qos:0 }); this.hello(); });
      m.on('message', (t, buf) => { let d; try { d = JSON.parse(buf.toString()); } catch (e) { return; } this.onHost(d, t.endsWith('/snap') ? 'snap' : 'relay'); });
      const fail = () => { if (ok || i < 0 || m.__dead) return; m.__dead = true; m.end(true); open((i + 1) % PAD_BROKERS.length); };
      m.on('error', fail); setTimeout(fail, 7000);
    };
    open(first);
    setInterval(() => this.heartbeat(), 1000);
  }
  setStatus(s){ this.status = s; this.onStatus(s); }
  hello(){ this.relaySend({ t:'hello', n:this.names }); }
  relaySend(o){ o.k = this.key; if (this.mq && this.mq.connected) this.mq.publish(TOPIC + this.code + '/net/up', JSON.stringify(o), { qos:0 }); }
  send(o){
    o.k = this.key;
    if (this.direct){ try { this.dc.send(JSON.stringify(o)); return; } catch (e) {} }
    this.relaySend(o);
  }
  // inputs for each local player: [steer, gas, brake, [fire, start, look] press counters]
  input(players){ if (!this.slots.length) return; this.send({ t:'in', e:this.epoch, s:++this.seq, n:this.names, p:players }); }
  onHost(d, via){
    if (!d || (d.to && d.to !== this.key)) return;
    this.hostSeen = performance.now();
    if (d.t === 'snap'){ if (via === 'snap' && this.direct) return; this.snapT = performance.now(); this.onSnap(d); return; }
    if (d.t === 'joined'){ this.slots = d.slots; if (this.status !== 'joined') this.setStatus('joined'); if (!this.direct) setTimeout(() => this.offer(), 200); }
    if (d.t === 'full'){ this.setStatus('full'); }
    if (d.t === 'who'){ this.slots = []; this.dropRtc(); this.hello(); }
    if (d.t === 'bye'){ this.slots = []; this.dropRtc(); this.setStatus('removed'); }
    if (d.t === 'answer' && this.pc && d.id === this.rtcId && !this.pc.currentRemoteDescription) this.pc.setRemoteDescription({ type:'answer', sdp:d.sdp }).catch(() => {});
    if (d.t === 'pong') this.ping = Math.round(performance.now() - d.ts);
  }
  heartbeat(){
    if (this.status === 'full' || this.status === 'removed') return;
    if (!this.slots.length){ this.hello(); return; }
    this.send({ t:'ping', ts:performance.now() });
    if (!this.direct && !this.pc) this.offer();
    const lost = performance.now() - this.hostSeen > 4000;
    if (lost && this.status === 'joined') this.setStatus('lost');
    else if (!lost && this.status === 'lost') this.setStatus('joined');
  }
  async offer(){
    if (this.direct || !this.mq || !this.mq.connected || !window.RTCPeerConnection || performance.now() - this.offerT < 4000) return;
    this.offerT = performance.now(); this.dropRtc(); this.tries++;
    const pc = this.pc = new RTCPeerConnection({ iceServers:ICE }), id = this.rtcId = Math.random().toString(36).slice(2, 10);
    const c = this.dc = pc.createDataChannel('net', { ordered:false, maxRetransmits:0 });
    c.onopen = () => { if (this.dc === c) this.onStatus(this.status); };
    c.onclose = () => { if (this.dc === c){ this.dc = null; this.onStatus(this.status); setTimeout(() => this.offer(), 3000); } };
    c.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (er) { return; } this.onHost(d, 'direct'); };
    try {
      await pc.setLocalDescription(await pc.createOffer()); await gathered(pc);
      if (this.pc === pc) this.relaySend({ t:'offer', id, sdp:pc.localDescription.sdp });
    } catch (e) {}
    // no direct link after 10s: the network blocks it, stay on the relay
    setTimeout(() => { if (this.pc === pc && !this.direct && this.tries < 4) this.offer(); }, 10000);
  }
  dropRtc(){ if (this.dc) try { this.dc.close(); } catch (e) {} if (this.pc) try { this.pc.close(); } catch (e) {} this.dc = this.pc = null; }
  leave(){ this.relaySend({ t:'bye' }); }
}

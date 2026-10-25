/* ============================================================
   Phones as controllers, up to 5 at once (same link as SpaceGeo, extended to many phones).
   The game opens a room and shows a QR code; each phone opens pad.html from it and streams
   steering, gas, brake and button presses.
   - Every message first goes through a relay: a public MQTT-over-WebSocket broker. It works
     on any network, but each message makes a round trip to the broker.
   - Through that relay each phone then sets up its own direct WebRTC data channel with the
     game (unordered, no retransmits). On the same Wi-Fi that is a few milliseconds, so inputs
     switch to it as soon as it opens and the relay stays as the backup.
   Phones publish on <topic>/up with their key `k`; the game publishes on <topic>/down and
   addresses one phone with `to` (no `to` = every phone). No server of our own is needed.
   ============================================================ */
export const PAD_CDN = {
  qr: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  mqtt: 'https://cdn.jsdelivr.net/npm/mqtt@5.10.4/dist/mqtt.min.js',
};
// public brokers, tried in order; the QR tells the phone which one the game is on (pad.html has the same list)
export const PAD_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const PAD_TOPIC = 'tekracers/v1/';
const PAD_ICE = [{ urls:['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls:'stun:stun.cloudflare.com:3478' }];
// where phones load pad.html from: next to this page when the game is served over http(s),
// otherwise (opened from a file) set window.PAD_HOME to the deployed address
const PAD_HOME = () => window.PAD_HOME || (/^https?:$/.test(location.protocol) ? location.href : '');
const BUTTONS = ['fire', 'start', 'look', 'cam'];

// one promise per script, shared by the phone link and the online link, so the second caller waits for the load
const loadJs = src => (window.__jsLoads = window.__jsLoads || {})[src] || (window.__jsLoads[src] = new Promise((ok, bad) => {
  if (src.includes('mqtt') && window.mqtt || src.includes('qrcode') && window.qrcode) return ok();
  const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { delete window.__jsLoads[src]; bad(new Error('Could not load ' + src)); }; document.head.appendChild(s);
}));

export class PadHost {
  constructor(){
    this.code = ''; this.status = 'off'; this.broker = 0;
    this.phones = new Map(); // key -> phone
    this.mq = null;
    // hooks the game sets
    this.onJoin = () => {}; this.onLeave = () => {}; this.onButton = () => {}; this.onStatus = () => {};
  }
  get url(){
    const base = PAD_HOME(); if (!base || !this.code) return '';
    const u = new URL('pad.html', base), q = new URLSearchParams(); q.set('b', String(this.broker));
    if (window.PAD_BROKER_URL) q.set('bu', window.PAD_BROKER_URL);
    u.search = '?' + q; u.hash = this.code; return u.href;
  }
  setStatus(s, msg){ this.status = s; this.statusMsg = msg || ''; this.onStatus(s, msg); }

  async start(){
    if (this.mq) return;
    this.setStatus('loading');
    try { await Promise.all([loadJs(PAD_CDN.qr), loadJs(PAD_CDN.mqtt)]); }
    catch (e) { this.setStatus('error', 'Could not reach the internet to set up phone controllers.'); return; }
    if (!this.code) this.code = PadHost.newCode();
    this.relay(0);
  }
  static newCode(){ const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; return c; }
  qrSvg(){
    const url = this.url; if (!url || !window.qrcode) return '';
    const g = window.qrcode(0, 'M'); g.addData(url); g.make(); return g.createSvgTag({ cellSize:4, margin:1, scalable:true });
  }

  relay(i){
    this.broker = i; const url = window.PAD_BROKER_URL || PAD_BROKERS[i]; let ok = false;
    const m = this.mq = window.mqtt.connect(url, { clientId:'brh-' + this.code + '-' + Math.random().toString(16).slice(2, 8), keepalive:20, reconnectPeriod:2000, connectTimeout:6000, clean:true });
    m.on('connect', () => { ok = true; m.subscribe(PAD_TOPIC + this.code + '/up', { qos:0 }); this.setStatus('waiting'); this.send({ t:'hi' }); });
    m.on('message', (t, buf) => { let d; try { d = JSON.parse(buf.toString()); } catch (e) { return; } this.onData(d, 'relay'); });
    const fail = () => { if (ok || window.PAD_BROKER_URL || i + 1 >= PAD_BROKERS.length || m.__dead) return; m.__dead = true; m.end(true); this.relay(i + 1); };
    m.on('error', fail); setTimeout(fail, 7000);
  }
  relaySend(o){ if (this.mq && this.mq.connected) this.mq.publish(PAD_TOPIC + this.code + '/down', JSON.stringify(o), { qos:0 }); }

  // send to one phone (by key) or to all (key omitted)
  send(o, key){
    if (key){
      const p = this.phones.get(key); o.to = key;
      if (p && p.dc && p.dc.readyState === 'open'){ try { p.dc.send(JSON.stringify(o)); return; } catch (e) {} }
      this.relaySend(o); return;
    }
    // broadcast: phones on a direct link get their own copy, one relay copy covers the rest
    let anyRelay = false;
    for (const p of this.phones.values()){
      if (p.dc && p.dc.readyState === 'open'){ try { p.dc.send(JSON.stringify(o)); continue; } catch (e) {} }
      anyRelay = true;
    }
    if (anyRelay || !this.phones.size) this.relaySend(o);
  }
  buzz(key, p){ this.send({ t:'buzz', p }, key); }

  // direct link: the phone sends a WebRTC offer through the relay, the game answers
  async onOffer(p, d){
    this.dropRtc(p); p.rtcId = d.id;
    const pc = p.pc = new RTCPeerConnection({ iceServers: PAD_ICE });
    pc.ondatachannel = e => { const c = p.dc = e.channel;
      c.onopen = () => { if (p.dc !== c) return; p.direct = true; this.onStatus(this.status); };
      c.onclose = () => { if (p.dc === c){ p.direct = false; p.dc = null; this.onStatus(this.status); } };
      c.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (er) { return; } m.k = p.key; this.onData(m, 'direct'); }; };
    pc.onconnectionstatechange = () => { if (p.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')){ p.direct = false; } };
    try {
      await pc.setRemoteDescription({ type:'offer', sdp:d.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await new Promise(ok => { if (pc.iceGatheringState === 'complete') return ok(); const t = setTimeout(ok, 2500); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete'){ clearTimeout(t); ok(); } }); });
      if (p.pc === pc) this.relaySend({ t:'answer', to:p.key, id:d.id, sdp:pc.localDescription.sdp });
    } catch (e) {}
  }
  dropRtc(p){ if (p.dc) try { p.dc.close(); } catch (e) {} if (p.pc) try { p.pc.close(); } catch (e) {} p.dc = p.pc = null; p.direct = false; }

  onData(d, via){
    if (!d || typeof d !== 'object' || typeof d.k !== 'string' || !d.k) return;
    let p = this.phones.get(d.k);
    if (!p){
      if (d.t === 'bye') return;
      p = { key:d.k, name: typeof d.n === 'string' && d.n.trim() ? d.n.trim().slice(0, 12) : 'Racer', steer:0, gas:0, brake:0, seq:0, cnt:null, last:performance.now(), direct:false, pc:null, dc:null, slot:-1 };
      // the game decides whether there is room (it answers with a slot or 'full')
      if (!this.onJoin(p)){ this.relaySend({ t:'full', to:d.k }); return; }
      this.phones.set(d.k, p);
    }
    p.last = performance.now();
    if (typeof d.n === 'string' && d.n.trim()) p.name = d.n.trim().slice(0, 12);
    if (d.t === 'offer'){ this.onOffer(p, d); return; }
    if (d.t === 'bye'){ this.drop(p.key, false); return; }
    if (d.t === 'ping'){ this.send({ t:'pong', ts:d.ts }, p.key); return; }
    // once the direct link is up, ignore late relay copies so older input never overrides newer
    if (via === 'relay' && p.direct && d.i) return;
    // inputs carry a sequence number per page load: drop anything older than what we have
    if (d.s !== undefined){ if (d.e !== p.epoch){ p.epoch = d.e; p.seq = 0; p.cnt = null; } if (d.s <= p.seq) return; p.seq = d.s; }
    if (Array.isArray(d.i)){ p.steer = Math.max(-1, Math.min(1, +d.i[0] || 0)); p.gas = +d.i[1] || 0; p.brake = +d.i[2] || 0; }
    // buttons arrive as running press counters, so a lost packet never drops a press
    if (Array.isArray(d.c)){
      if (!p.cnt) p.cnt = d.c.slice();
      BUTTONS.forEach((b, i) => { if (d.c[i] > p.cnt[i]) this.onButton(p, b); });
      p.cnt = d.c.slice();
    }
  }
  drop(key, tell = true){
    const p = this.phones.get(key); if (!p) return;
    if (tell) this.relaySend({ t:'bye', to:key });
    this.dropRtc(p); this.phones.delete(key); this.onLeave(p);
  }
  // call every frame: zero inputs on a quiet phone, drop phones that went away
  tick(){
    const now = performance.now();
    for (const p of [...this.phones.values()]){
      const quiet = now - p.last;
      if (quiet > 1500){ p.steer = p.gas = p.brake = 0; }
      // the phone sends a heartbeat every 200ms; a long silence means it slept or closed the page
      if (quiet > 12000) this.drop(p.key, false);
    }
  }
  newRoom(){
    for (const k of [...this.phones.keys()]) this.drop(k);
    if (this.mq){ this.mq.__dead = true; this.mq.end(true); this.mq = null; }
    this.code = PadHost.newCode(); this.start();
  }
}

/* ============================================================
   One race: kart driving, laps and positions, brick pickups, power-ups, AI drivers and effects.
   Power-ups work like the classic brick racer: a colour brick picks the kind of power-up,
   white bricks (up to 3) make it stronger, and using it spends them all.
     red    : cannon ball · homing missile · twin missiles · lightning on everyone ahead
     yellow : oil slick · mine · mine field · shockwave around you
     blue   : shield · long shield · spike shield (spins karts you touch) · super shield
     green  : turbo · big turbo · mega turbo · warp forward
   ============================================================ */
import * as THREE from 'three';
import { kart, brick, toon, basic, COLORS } from './models.js';
import { HALF_W } from './track.js';
import { Snd } from './audio.js';

export const PU = {
  red:    { col:COLORS.red,    names:['Cannon', 'Homing missile', 'Twin missiles', 'Lightning'] },
  yellow: { col:COLORS.yellow, names:['Oil slick', 'Mine', 'Mine field', 'Shockwave'] },
  blue:   { col:COLORS.blue,   names:['Shield', 'Long shield', 'Spike shield', 'Super shield'] },
  green:  { col:COLORS.green,  names:['Turbo', 'Big turbo', 'Mega turbo', 'Warp'] },
};
const KINDS = ['red', 'yellow', 'blue', 'green'];
const MAX_SPEED = 40, ACCEL = 24, BRAKE = 50, REVERSE = 12, TURN = 2.0, GRIP = 7, LIM = HALF_W - 1.5, KART_R = 1.7;
export const AI_NAMES = ['Cap\'n Stud', 'Rita Rocket', 'Baron Bolt', 'Kiki Tiki', 'Sir Plate'];
const START = 4; // sample index of the start line

const wrapPi = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Race {
  constructor(scene, track, players, laps){
    this.scene = scene; this.track = track; this.laps = laps;
    this.root = new THREE.Group(); scene.add(this.root);
    this.time = 0; this.state = 'countdown'; this.count = 3.6; this.lastCount = 4; this.overT = 0;
    this.projectiles = []; this.hazards = []; this.fx = []; this.bricks = [];
    this.karts = players.map((pl, i) => this.makeKart(pl, i));
    this.placeBricks();
  }
  dispose(){ this.scene.remove(this.root); }

  makeKart(pl, i){
    const t = this.track, idx = t.wrap(START - 8 - i * 7), side = i % 2 ? 4.2 : -4.2;
    const mesh = kart(pl.color, pl.kind === 'ai' ? COLORS.white : pl.color, i);
    const p = t.pos(idx, side); mesh.position.copy(p);
    this.root.add(mesh);
    const k = { pl, mesh, x:p.x, z:p.z, y:p.y, h:t.heading(idx), vx:0, vz:0, idx, prog: -(t.wrap(START - idx)), lapDone:0,
      place:i + 1, fin:false, finT:0, pu:null, w:0, spin:0, flip:0, boost:0, shield:0, shieldLvl:0, inv:0, wrongT:0, wrong:false,
      wheel:0, steer:0, look:0, speed:0, bumpT:0,
      cam: new THREE.PerspectiveCamera(70, 1, .3, 2000), camPos:new THREE.Vector3(), camLook:new THREE.Vector3(),
      ai: pl.kind === 'ai' ? { lane:(Math.random() - .5) * 8, laneT:0, skill:.9 + Math.random() * .07, hold:0 } : null };
    // start the camera behind the kart
    const f = new THREE.Vector3(Math.sin(k.h), 0, Math.cos(k.h));
    k.camPos.set(k.x - f.x * 10, k.y + 4.5, k.z - f.z * 10); k.camLook.set(k.x + f.x * 6, k.y + 1.2, k.z + f.z * 6);
    return k;
  }

  /* ---------- bricks ---------- */
  placeBricks(){
    const t = this.track;
    for (const f of [.1, .27, .44, .6, .76, .9]){
      const idx = Math.round(t.N * f);
      for (const s of [-5.4, -1.8, 1.8, 5.4]){
        const b = { idx, side:s, pos:t.pos(idx, s), mesh:null, color:null, active:false, respawn:0, phase:Math.random() * 6 };
        this.spawnBrick(b); this.bricks.push(b);
      }
    }
  }
  spawnBrick(b){
    if (b.mesh) this.root.remove(b.mesh);
    b.color = Math.random() < .3 ? 'white' : KINDS[Math.random() * 4 | 0];
    b.mesh = brick(COLORS[b.color]); b.mesh.position.copy(b.pos); b.mesh.position.y += 1.4; this.root.add(b.mesh);
    const bl = new THREE.Mesh(new THREE.CircleGeometry(1.2, 16).rotateX(-Math.PI / 2), basic('#000000', { transparent:true, opacity:.22, depthWrite:false }));
    bl.position.y = -1.3; b.mesh.add(bl);
    b.active = true;
  }
  collect(k, b){
    b.active = false; b.respawn = 4; this.root.remove(b.mesh); b.mesh = null;
    this.burst(b.pos.x, b.pos.y + 1.4, b.pos.z, COLORS[b.color], 6, 8);
    if (b.color === 'white'){ if (k.w < 3) k.w++; }
    else k.pu = b.color;
    if (k.pl.kind !== 'ai'){ Snd.play(b.color === 'white' ? 'white' : 'brick'); k.pl.notify({ e:'pick' }); }
    if (k.ai) k.ai.hold = .6 + Math.random() * 2.5;
  }

  /* ---------- main update ---------- */
  update(dt){
    this.time += dt;
    if (this.state === 'countdown'){
      this.count -= dt;
      const c = Math.ceil(this.count - .6);
      if (c < this.lastCount && c >= 1){ this.lastCount = c; Snd.play('count'); this.onEvent({ e:'count', n:c }); }
      if (this.count <= .6){
        this.state = 'race'; this.raceStart = this.time; Snd.play('go'); this.onEvent({ e:'go' });
        // a rocket start for anyone holding the gas at GO
        for (const k of this.karts) if (k.pl.input.gas || k.ai) k.boost = k.ai ? .3 + Math.random() * .4 : .8;
      }
    }
    const racing = this.state === 'race' || this.state === 'over';
    for (const k of this.karts){ if (k.ai && racing) this.think(k, dt); this.drive(k, racing ? dt : 0, dt); }
    this.collide();
    this.updateBricks(dt);
    this.updateProjectiles(dt);
    this.updateHazards(dt);
    this.updateFx(dt);
    this.rank();
    if (this.state === 'race'){
      const humans = this.karts.filter(k => k.pl.kind !== 'ai');
      if (humans.length && humans.every(k => k.fin)){ this.state = 'over'; this.overT = 3; }
    }
    if (this.state === 'over'){ this.overT -= dt; if (this.overT <= 0){ this.state = 'done'; } }
    for (const k of this.karts) this.updateCam(k, dt);
  }
  get raceTime(){ return this.raceStart ? this.time - this.raceStart : 0; }

  drive(k, dt, rdt){
    const t = this.track, inp = k.ai ? k.ai.inp || { steer:0, gas:0, brake:0 } : k.pl.input;
    k.spin = Math.max(0, k.spin - rdt); k.flip = Math.max(0, k.flip - rdt); k.boost = Math.max(0, k.boost - rdt);
    k.shield = Math.max(0, k.shield - rdt); k.inv = Math.max(0, k.inv - rdt); k.bumpT = Math.max(0, k.bumpT - rdt); k.look = Math.max(0, k.look - rdt);
    const stunned = k.spin > 0 || k.flip > 0;
    let steer = stunned ? 0 : clamp(inp.steer, -1, 1), gas = stunned ? 0 : inp.gas ? 1 : 0, brake = stunned ? 0 : inp.brake ? 1 : 0;
    // finished karts cruise on autopilot
    if (k.fin){ const a = this.autopilot(k); steer = a.steer; gas = .55; brake = 0; }
    k.steer += (steer - k.steer) * Math.min(1, rdt * 10);
    const fx = Math.sin(k.h), fz = Math.cos(k.h), rx = -Math.cos(k.h), rz = Math.sin(k.h);
    let fwd = k.vx * fx + k.vz * fz, lat = k.vx * rx + k.vz * rz;
    let max = MAX_SPEED * (k.ai ? k.ai.skill * this.rubber(k) : 1) * (k.shieldLvl >= 3 && k.shield > 0 ? 1.08 : 1);
    if (k.boost > 0) max *= 1.5;
    if (dt > 0){
      if (k.boost > 0) fwd += (max - fwd) * Math.min(1, dt * 4);
      else if (gas) fwd += ACCEL * dt * Math.max(0, 1 - fwd / max) * (fwd < 12 ? 1.6 : 1);
      if (brake){ if (fwd > .5) fwd -= BRAKE * dt; else fwd = Math.max(-REVERSE, fwd - ACCEL * .6 * dt); }
      if (!gas && !brake && k.boost <= 0) fwd -= fwd * .6 * dt;
      if (fwd > max) fwd += (max - fwd) * Math.min(1, dt * 2);
      // steering: stronger at low speed, gentler at full speed, reversed when backing up
      const sp = Math.abs(fwd), turn = TURN * Math.min(1, sp / 8) * (1 - .3 * Math.min(1, sp / MAX_SPEED)) * Math.sign(fwd || 1);
      k.h -= k.steer * turn * dt;
      if (k.spin > 0) { k.h += dt * 9; fwd *= Math.pow(.25, dt); }
      if (k.flip > 0) fwd *= Math.pow(.2, dt);
      // keep sideways slide low: a touch of drift when cornering hard
      lat *= Math.exp(-GRIP * dt * (k.spin > 0 ? .2 : 1));
      const nfx = Math.sin(k.h), nfz = Math.cos(k.h), nrx = -Math.cos(k.h), nrz = Math.sin(k.h);
      k.vx = nfx * fwd + nrx * lat; k.vz = nfz * fwd + nrz * lat;
      k.x += k.vx * dt; k.z += k.vz * dt;
    }
    // stay on the road: the brick walls push back
    const loc = t.locate(k.x, k.z, k.idx);
    if (Math.abs(loc.side) > LIM){
      const s = Math.sign(loc.side), r = t.R[loc.i], over = Math.abs(loc.side) - LIM;
      k.x -= r.x * s * over; k.z -= r.z * s * over;
      const vn = (k.vx * r.x + k.vz * r.z) * s;
      if (vn > 0){ k.vx -= r.x * s * vn * 1.3; k.vz -= r.z * s * vn * 1.3; k.vx *= .97; k.vz *= .97;
        if (vn > 7 && !k.bumpT){ k.bumpT = .4; if (k.pl.kind !== 'ai') Snd.play('bump'); this.burst(k.x + r.x * s * 1.5, loc.y + .8, k.z + r.z * s * 1.5, '#ffffff', 3, 4, 'puff'); } }
      // turn the nose along the wall a little when scraping it
      const th = t.heading(loc.i), d = wrapPi(th - k.h); if (Math.abs(d) < 1.2 && vn > 0) k.h += d * Math.min(1, rdt * 2);
    }
    // progress around the lap
    let d = loc.i - k.idx; const N = t.N; if (d > N / 2) d -= N; if (d < -N / 2) d += N;
    k.idx = loc.i; k.prog += d;
    const lapsDone = Math.floor(k.prog / N);
    if (lapsDone > k.lapDone && !k.fin){
      k.lapDone = lapsDone;
      if (lapsDone >= this.laps){ k.fin = true; k.finT = this.raceTime; if (k.pl.kind !== 'ai'){ Snd.play('finish'); k.pl.notify({ e:'finish' }); } }
      else if (k.pl.kind !== 'ai'){ Snd.play('lap'); k.pl.notify({ e:'lap', txt: lapsDone === this.laps - 1 ? 'Final lap!' : 'Lap ' + (lapsDone + 1) }); }
    }
    // driving the wrong way?
    const tt = t.T[loc.i], spd = Math.hypot(k.vx, k.vz);
    if (spd > 4 && (k.vx * tt.x + k.vz * tt.z) / spd < -.4 && this.state === 'race') k.wrongT += rdt; else k.wrongT = 0;
    k.wrong = k.wrongT > 1.2;
    k.speed = fwd;
    // place the model
    const m = k.mesh, flipH = k.flip > 0 ? Math.sin((1 - k.flip / 1.4) * Math.PI) * 5 : 0;
    k.y += ((loc.y) - k.y) * Math.min(1, rdt * 12);
    m.position.set(k.x, k.y + flipH, k.z);
    m.rotation.y = k.h;
    m.rotation.x = -Math.atan2(loc.slope, 1) * .9;
    const body = m.userData.body;
    body.rotation.z = -k.steer * Math.min(1, Math.abs(fwd) / MAX_SPEED) * .12;
    body.rotation.x = k.flip > 0 ? (1 - k.flip / 1.4) * Math.PI * 2 : 0;
    body.position.y = k.flip > 0 ? 1 : Math.sin(this.time * 30 + k.pl.slot) * .02 * Math.min(1, Math.abs(fwd) / 10);
    m.userData.blob.position.y = .06 - flipH; m.userData.blob.scale.setScalar(1 / (1 + flipH * .15));
    k.wheel += fwd * rdt / .55;
    for (const w of m.userData.wheels) w.children[0].rotation.x = k.wheel;
    for (const w of m.userData.front) w.rotation.y = -k.steer * .45;
    m.userData.driver.userData.head.rotation.y = -k.steer * .35;
    m.userData.shield.visible = k.shield > 0 && (k.shield > 1 || Math.sin(this.time * 30) > 0);
    if (m.userData.shield.visible){ m.userData.shield.material.color.set(k.shieldLvl >= 2 ? '#ff9de2' : '#6fd0ff'); m.userData.shield.rotation.y += rdt * 2; }
    const fl = m.userData.flames; fl.visible = k.boost > 0; if (fl.visible) fl.scale.set(1, 1, .7 + Math.random() * .6);
    m.visible = !(k.inv > 0 && k.warped && Math.sin(this.time * 40) > .3);
  }
  // keep the pack together a little so everyone stays in the race
  rubber(k){
    const humans = this.karts.filter(o => o.pl.kind !== 'ai'); if (!humans.length) return 1;
    const lead = Math.max(...humans.map(o => o.prog)), d = k.prog - lead;
    return d > 150 ? .9 : d < -150 ? 1.06 : 1;
  }
  autopilot(k){
    const t = this.track, la = 10 + Math.max(0, k.speed) * .35, p = t.pos(k.idx + la, k.ai ? k.ai.lane : 0);
    const want = Math.atan2(p.x - k.x, p.z - k.z), d = wrapPi(want - k.h);
    return { steer: clamp(-d * 2.4, -1, 1), d };
  }

  /* ---------- AI drivers ---------- */
  think(k, dt){
    const a = k.ai, t = this.track;
    a.laneT -= dt; if (a.laneT <= 0){ a.laneT = 1.5 + Math.random() * 3; a.lane = clamp(a.lane + (Math.random() - .5) * 6, -5.5, 5.5); }
    // go for a brick in the next row when it has nothing to use yet
    if (!k.pu || k.w < 3){
      for (const b of this.bricks){ const ahead = t.wrap(b.idx - k.idx); if (b.active && ahead > 6 && ahead < 45 && (!k.pu || b.color === 'white')){ a.lane = b.side; break; } }
    }
    const ap = this.autopilot(k);
    a.inp = { steer:ap.steer, gas:1, brake: Math.abs(ap.d) > 1.1 && k.speed > 18 ? 1 : 0 };
    // stuck against a wall: back up
    if (Math.abs(ap.d) > 2 && k.speed < 3){ a.inp = { steer:-ap.steer, gas:0, brake:1 }; }
    if (k.pu){ a.hold -= dt; if (a.hold <= 0 && this.aiWants(k)){ this.use(k); a.hold = 1; } }
  }
  aiWants(k){
    const ahead = this.karts.filter(o => o !== k && o.prog > k.prog && o.prog - k.prog < 120);
    const behind = this.karts.filter(o => o !== k && o.prog < k.prog && k.prog - o.prog < 50);
    if (k.pu === 'red') return ahead.length > 0 || k.w >= 3;
    if (k.pu === 'yellow') return behind.length > 0 || (k.w >= 3 && ahead.some(o => o.prog - k.prog < 18));
    if (k.pu === 'blue') return this.projectiles.some(p => p.owner !== k && Math.hypot(p.x - k.x, p.z - k.z) < 30) || Math.random() < .01;
    if (k.pu === 'green') return Math.abs(this.track.bend[this.track.wrap(k.idx + 15)]) < .25;
    return true;
  }

  /* ---------- power-ups ---------- */
  use(k){
    if (!k.pu || this.state !== 'race' && this.state !== 'over' || k.flip > 0) return false;
    const kind = k.pu, lv = k.w; k.pu = null; k.w = 0;
    const human = k.pl.kind !== 'ai';
    if (kind === 'red'){
      if (lv === 0){ this.fire(k, 'cannon', 0); human && Snd.play('cannon'); }
      else if (lv < 3){ for (let i = 0; i < lv; i++) this.fire(k, 'missile', (i - (lv - 1) / 2) * .35, i); human && Snd.play('missile'); }
      else this.lightning(k);
    } else if (kind === 'yellow'){
      if (lv === 0) this.drop(k, 'oil', 0);
      else if (lv === 1) this.drop(k, 'mine', 0);
      else if (lv === 2) [-4, 0, 4].forEach(s => this.drop(k, 'mine', s));
      else this.shockwave(k);
      human && Snd.play(lv === 0 ? 'oil' : 'bump');
    } else if (kind === 'blue'){
      k.shield = [3.5, 6, 8, 10][lv]; k.shieldLvl = lv; human && Snd.play('shield');
    } else if (kind === 'green'){
      if (lv < 3){ k.boost = [1.2, 2, 3][lv]; human && Snd.play('turbo'); }
      else this.warp(k);
    }
    return true;
  }
  fire(k, kind, ang, n = 0){
    const f = new THREE.Vector3(Math.sin(k.h + ang), 0, Math.cos(k.h + ang));
    const mesh = new THREE.Group();
    if (kind === 'cannon'){ const b = new THREE.Mesh(new THREE.SphereGeometry(.7, 14, 10), toon(COLORS.black)); mesh.add(b); }
    else { const b = new THREE.Mesh(new THREE.CylinderGeometry(.35, .35, 2, 10).rotateX(Math.PI / 2), toon(COLORS.white)); mesh.add(b);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(.35, .7, 10).rotateX(Math.PI / 2), toon(COLORS.red)); nose.position.z = 1.3; mesh.add(nose);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(1.2, .1, .5), toon(COLORS.red)); fin.position.z = -.8; mesh.add(fin); }
    const p = { kind, mesh, owner:k, x:k.x + f.x * 3, z:k.z + f.z * 3, y:k.y + 1.2, h:k.h + ang, speed:kind === 'cannon' ? 75 : 62, life:kind === 'cannon' ? 2.5 : 5, idx:k.idx, target:null, delay:n * .15, trail:0 };
    if (kind === 'missile'){
      // lock on to the n-th kart ahead
      const ahead = this.karts.filter(o => o !== k && o.prog > k.prog).sort((a, b) => a.prog - b.prog);
      p.target = ahead[Math.min(n, ahead.length - 1)] || null;
    }
    mesh.position.set(p.x, p.y, p.z); this.root.add(mesh); this.projectiles.push(p);
  }
  updateProjectiles(dt){
    const t = this.track;
    for (const p of [...this.projectiles]){
      p.life -= dt;
      if (p.target && !p.target.fin){
        const want = Math.atan2(p.target.x - p.x, p.target.z - p.z); p.h += clamp(wrapPi(want - p.h), -3.2 * dt, 3.2 * dt);
      } else { // follow the road
        const want = t.heading(p.idx + 6); p.h += clamp(wrapPi(want - p.h), -1.5 * dt, 1.5 * dt);
      }
      p.x += Math.sin(p.h) * p.speed * dt; p.z += Math.cos(p.h) * p.speed * dt;
      const loc = t.locate(p.x, p.z, p.idx); p.idx = loc.i; p.y = loc.y + 1.2;
      if (Math.abs(loc.side) > LIM + 1){ // bounce off the wall
        const r = t.R[loc.i], s = Math.sign(loc.side); p.x -= r.x * s * (Math.abs(loc.side) - LIM - 1); p.z -= r.z * s * (Math.abs(loc.side) - LIM - 1);
        const th = t.heading(loc.i); p.h = th + wrapPi(th - p.h) * .5; if (p.kind === 'cannon') p.life -= .4;
      }
      p.mesh.position.set(p.x, p.y, p.z); p.mesh.rotation.y = p.h;
      p.trail -= dt; if (p.trail <= 0){ p.trail = .04; this.burst(p.x, p.y, p.z, p.kind === 'cannon' ? '#cfcfcf' : '#ffd36b', 1, 1, 'puff'); }
      let done = p.life <= 0;
      for (const k of this.karts){
        if (k === p.owner && p.life > (p.kind === 'cannon' ? 2.2 : 4.6)) continue;
        if (Math.hypot(k.x - p.x, k.z - p.z) < KART_R + .9 && Math.abs(k.y - p.y) < 4){ this.hit(k, p.kind === 'cannon' ? 'spin' : 'flip', p.owner); done = true; break; }
      }
      if (done){ this.root.remove(p.mesh); this.projectiles.splice(this.projectiles.indexOf(p), 1); this.burst(p.x, p.y, p.z, COLORS.orange, 8, 10); Snd.play('boom'); }
    }
  }
  drop(k, kind, side){
    const t = this.track, f = new THREE.Vector3(Math.sin(k.h), 0, Math.cos(k.h)), r = t.R[k.idx];
    const x = k.x - f.x * 3.5 + r.x * side, z = k.z - f.z * 3.5 + r.z * side, loc = t.locate(x, z, k.idx);
    let mesh;
    if (kind === 'oil'){ mesh = new THREE.Mesh(new THREE.CircleGeometry(3, 20).rotateX(-Math.PI / 2), basic('#15121c')); mesh.position.set(x, loc.y + .12, z); mesh.scale.set(1, 1, .8); }
    else { mesh = new THREE.Group(); const b = new THREE.Mesh(new THREE.SphereGeometry(.8, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), toon(COLORS.dark)); mesh.add(b);
      const l = new THREE.Mesh(new THREE.SphereGeometry(.25, 8, 6), basic(COLORS.red)); l.position.y = .75; mesh.add(l); mesh.userData.light = l; mesh.position.set(x, loc.y + .1, z); }
    this.root.add(mesh);
    this.hazards.push({ kind, mesh, x, z, owner:k, life:kind === 'oil' ? 18 : 30, arm:.6, hitBy:new Map() });
  }
  updateHazards(dt){
    for (const h of [...this.hazards]){
      h.life -= dt; h.arm -= dt;
      if (h.mesh.userData.light) h.mesh.userData.light.visible = Math.sin(this.time * 12) > 0;
      let gone = h.life <= 0;
      for (const k of this.karts){
        if (h.arm > 0 && k === h.owner) continue;
        const d = Math.hypot(k.x - h.x, k.z - h.z);
        if (h.kind === 'oil' && d < 3.2){ const last = h.hitBy.get(k) || -9; if (this.time - last > 2){ h.hitBy.set(k, this.time); this.hit(k, 'spin', h.owner, true); } }
        if (h.kind === 'mine' && d < 2.4){ this.hit(k, 'flip', h.owner); gone = true; this.burst(h.x, .8, h.z, COLORS.orange, 10, 12); Snd.play('boom'); break; }
      }
      if (gone){ this.root.remove(h.mesh); this.hazards.splice(this.hazards.indexOf(h), 1); }
    }
  }
  lightning(k){
    Snd.play('zap'); this.onEvent({ e:'flash', col:'#fff8a0' });
    for (const o of this.karts) if (o !== k && o.prog > k.prog){
      this.bolt(o.x, o.y, o.z); this.hit(o, 'spin', k);
    }
  }
  bolt(x, y, z){
    const pts = []; let px = x, pz = z;
    for (let i = 0; i <= 10; i++){ pts.push(new THREE.Vector3(px, y + 40 - i * 4, pz)); px = x + (Math.random() - .5) * 3; pz = z + (Math.random() - .5) * 3; }
    pts[10].set(x, y + 1, z);
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, .25, 5, false);
    const m = new THREE.Mesh(g, basic('#fff36b')); this.root.add(m);
    this.fx.push({ mesh:m, life:.45, max:.45, kind:'bolt' });
  }
  shockwave(k){
    Snd.play('boom');
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, .35, 8, 40).rotateX(Math.PI / 2), basic('#fff36b')); ring.position.set(k.x, k.y + .8, k.z); this.root.add(ring);
    this.fx.push({ mesh:ring, life:.6, max:.6, kind:'ring', r:24 });
    for (const o of this.karts) if (o !== k && Math.hypot(o.x - k.x, o.z - k.z) < 24) this.hit(o, 'flip', k);
  }
  warp(k){
    const t = this.track, jump = Math.round(t.N * .09);
    this.burst(k.x, k.y + 1, k.z, '#c58bff', 14, 10);
    const ni = t.wrap(k.idx + jump), p = t.pos(ni, 0);
    k.x = p.x; k.z = p.z; k.y = p.y; k.idx = ni; k.prog += jump; k.h = t.heading(ni);
    const sp = Math.max(k.speed, MAX_SPEED * .8); k.vx = Math.sin(k.h) * sp; k.vz = Math.cos(k.h) * sp;
    k.inv = 1.2; k.warped = true; k.camPos.set(k.x - Math.sin(k.h) * 10, k.y + 4.5, k.z - Math.cos(k.h) * 10);
    this.burst(k.x, k.y + 1, k.z, '#c58bff', 14, 10);
    if (k.pl.kind !== 'ai') Snd.play('warp');
  }
  hit(k, type, by, soft){
    if (k.inv > 0 || k.fin) return;
    if (k.shield > 0){ this.burst(k.x, k.y + 1.5, k.z, '#9fe8ff', 8, 8); return; }
    if (type === 'spin'){ k.spin = soft ? .9 : 1.2; }
    else { k.flip = 1.4; k.vx *= .3; k.vz *= .3; }
    k.inv = type === 'flip' ? 1.8 : 1.3; k.warped = false;
    // bricks fly off the kart
    this.burst(k.x, k.y + 1.2, k.z, k.pl.color, 8, 12, 'brick');
    if (k.pl.kind !== 'ai'){ Snd.play('spin'); k.pl.notify({ e:'hit' }); }
  }

  /* ---------- kart to kart ---------- */
  collide(){
    const ks = this.karts;
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++){
      const a = ks[i], b = ks[j], dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d >= KART_R * 2 || d < .001 || Math.abs(a.y - b.y) > 3) continue;
      const nx = dx / d, nz = dz / d, push = (KART_R * 2 - d) / 2;
      a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
      const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rv < 0){ const imp = -rv * .8; a.vx -= nx * imp * .5; a.vz -= nz * imp * .5; b.vx += nx * imp * .5; b.vz += nz * imp * .5;
        if (imp > 6 && (a.pl.kind !== 'ai' || b.pl.kind !== 'ai')) Snd.play('bump'); }
      // spike shields spin out whoever they touch
      if (a.shield > 0 && a.shieldLvl >= 2 && !(b.shield > 0)) this.hit(b, 'spin', a);
      if (b.shield > 0 && b.shieldLvl >= 2 && !(a.shield > 0)) this.hit(a, 'spin', b);
    }
  }

  updateBricks(dt){
    for (const b of this.bricks){
      if (!b.active){ b.respawn -= dt; if (b.respawn <= 0) this.spawnBrick(b); continue; }
      b.mesh.rotation.y += dt * 2; b.mesh.position.y = b.pos.y + 1.4 + Math.sin(this.time * 3 + b.phase) * .3;
      for (const k of this.karts) if (k.flip <= 0 && Math.hypot(k.x - b.pos.x, k.z - b.pos.z) < 2.6){ this.collect(k, b); break; }
    }
  }

  /* ---------- effects: brick shards, puffs, rings and bolts ---------- */
  burst(x, y, z, color, n, speed, kind = 'shard'){
    for (let i = 0; i < n; i++){
      const m = new THREE.Mesh(kind === 'puff' ? Race.puffG : Race.shardG, kind === 'puff' ? toon('#ffffff') : toon(color));
      m.position.set(x, y, z); const s = kind === 'puff' ? .5 + Math.random() * .5 : .6 + Math.random() * .5; m.scale.setScalar(s);
      this.root.add(m);
      const a = Math.random() * Math.PI * 2, up = kind === 'puff' ? 1 + Math.random() : 4 + Math.random() * 8;
      this.fx.push({ mesh:m, kind, life:kind === 'puff' ? .5 : 1.1, max:kind === 'puff' ? .5 : 1.1, s,
        v:new THREE.Vector3(Math.cos(a) * speed * Math.random(), up, Math.sin(a) * speed * Math.random()), r:new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0) });
    }
  }
  updateFx(dt){
    for (const f of [...this.fx]){
      f.life -= dt; const k = Math.max(0, f.life / f.max);
      if (f.kind === 'shard' || f.kind === 'brick'){ f.v.y -= 30 * dt; f.mesh.position.addScaledVector(f.v, dt); f.mesh.rotation.x += f.r.x * dt; f.mesh.rotation.y += f.r.y * dt; f.mesh.scale.setScalar(f.s * Math.min(1, k * 3)); }
      else if (f.kind === 'puff'){ f.mesh.position.addScaledVector(f.v, dt); f.mesh.scale.setScalar(f.s * (1 + (1 - k) * 1.5) * k); }
      else if (f.kind === 'ring'){ const r = 1 + (1 - k) * f.r; f.mesh.scale.set(r, 1, r); }
      else if (f.kind === 'bolt'){ f.mesh.visible = Math.sin(f.life * 80) > -.3; }
      if (f.life <= 0){ this.root.remove(f.mesh); if (f.kind === 'bolt' || f.kind === 'ring') f.mesh.geometry.dispose(); this.fx.splice(this.fx.indexOf(f), 1); }
    }
    for (const fl of this.track.flags || []) fl.userData.cloth.rotation.y = Math.sin(this.time * 4 + fl.position.x) * .25;
  }

  rank(){
    const order = [...this.karts].sort((a, b) => (a.fin && b.fin) ? a.finT - b.finT : a.fin ? -1 : b.fin ? 1 : b.prog - a.prog);
    order.forEach((k, i) => k.place = i + 1);
    this.order = order;
  }
  updateCam(k, dt){
    const f = new THREE.Vector3(Math.sin(k.h), 0, Math.cos(k.h)), back = k.look > 0 ? -1 : 1;
    const dist = 9.5 + Math.max(0, k.speed) * .05, wantP = new THREE.Vector3(k.x - f.x * dist * back, k.y + 4.2, k.z - f.z * dist * back);
    const wantL = new THREE.Vector3(k.x + f.x * 6 * back, k.y + 1.4, k.z + f.z * 6 * back);
    const a = 1 - Math.exp(-dt * (k.look > 0 ? 30 : 7));
    k.camPos.lerp(wantP, a); k.camLook.lerp(wantL, 1 - Math.exp(-dt * 12));
    k.cam.position.copy(k.camPos); k.cam.lookAt(k.camLook);
    const fov = 68 + (k.boost > 0 ? 10 : 0) + Math.max(0, k.speed) * .1;
    if (Math.abs(k.cam.fov - fov) > .05){ k.cam.fov += (fov - k.cam.fov) * Math.min(1, dt * 5); k.cam.updateProjectionMatrix(); }
  }
  results(){
    return this.order.map(k => ({ name:k.pl.name, color:k.pl.color, kind:k.pl.kind, fin:k.fin, time:k.finT, place:k.place }));
  }
  onEvent(){ }
}
Race.shardG = new THREE.BoxGeometry(.8, .5, .8);
Race.puffG = new THREE.SphereGeometry(.8, 8, 6);

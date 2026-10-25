/* ============================================================
   Synth sound: every effect and the music are made with Web Audio oscillators, no files.
   ============================================================ */
export const Snd = (() => {
  let ac = null, master = null, sfx = null, mus = null, eng = null, musicOn = true, soundOn = true, seqT = 0, step = 0, nextT = 0;
  const store = { get(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} } };
  musicOn = store.get('br-music') !== '0'; soundOn = store.get('br-sound') !== '0';

  function init(){
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    ac = new C(); master = ac.createGain(); master.gain.value = .7; master.connect(ac.destination);
    sfx = ac.createGain(); sfx.gain.value = soundOn ? 1 : 0; sfx.connect(master);
    mus = ac.createGain(); mus.gain.value = musicOn ? .22 : 0; mus.connect(master);
    // engine: two detuned saws through a lowpass, pitch follows speed
    const g = ac.createGain(); g.gain.value = 0; const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
    const o1 = ac.createOscillator(), o2 = ac.createOscillator(); o1.type = 'sawtooth'; o2.type = 'square'; o1.frequency.value = 60; o2.frequency.value = 61.5;
    const g2 = ac.createGain(); g2.gain.value = .35; o2.connect(g2); g2.connect(f); o1.connect(f); f.connect(g); g.connect(sfx); o1.start(); o2.start();
    eng = { g, f, o1, o2 };
    nextT = ac.currentTime + .1; seqT = setInterval(schedule, 50);
  }
  const now = () => ac.currentTime;
  function tone(freq, dur, type = 'square', vol = .2, slide = 0, delay = 0, dest = sfx){
    if (!ac) return; const t = now() + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + .02);
  }
  function noise(dur, vol = .3, freq = 1200, delay = 0, q = 1, dest = sfx){
    if (!ac) return; const t = now() + delay, n = ac.sampleRate * dur | 0, b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = b; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; g.gain.value = vol;
    s.connect(f); f.connect(g); g.connect(dest); s.start(t);
  }
  const FX = {
    nav:   () => tone(660, .06, 'square', .08),
    select:() => { tone(520, .07, 'square', .1); tone(780, .09, 'square', .1, 0, .06); },
    back:  () => tone(400, .08, 'square', .08, .7),
    join:  () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, .12, 'square', .12, 0, i * .07)); },
    leave: () => { tone(500, .12, 'square', .1, .5); },
    count: () => tone(440, .25, 'square', .18),
    go:    () => { tone(880, .5, 'square', .2); tone(1320, .5, 'triangle', .12); },
    brick: () => { tone(880, .07, 'square', .12); tone(1175, .1, 'square', .12, 0, .05); },
    white: () => { [784, 988, 1175, 1568].forEach((f, i) => tone(f, .08, 'triangle', .14, 0, i * .04)); },
    cannon:() => { noise(.25, .5, 300); tone(140, .25, 'sawtooth', .2, .4); },
    missile:() => { noise(.6, .25, 2200, 0, 3); tone(300, .6, 'sawtooth', .08, 2.5); },
    boom:  () => { noise(.7, .7, 160); tone(90, .5, 'sawtooth', .25, .3); },
    zap:   () => { for (let i = 0; i < 6; i++) tone(200 + Math.random() * 1600, .06, 'sawtooth', .12, .5, i * .04); noise(.4, .4, 3000); },
    oil:   () => { tone(200, .3, 'sine', .2, .3); noise(.2, .2, 600); },
    shield:() => { tone(330, .5, 'sine', .15, 2); tone(495, .5, 'sine', .1, 2, .05); },
    turbo: () => { noise(.8, .35, 900, 0, .7); tone(200, .7, 'sawtooth', .1, 3); },
    warp:  () => { for (let i = 0; i < 10; i++) tone(300 + i * 120, .08, 'triangle', .12, 1, i * .03); },
    spin:  () => { tone(600, .6, 'square', .1, .25); noise(.3, .25, 1500); },
    bump:  () => { noise(.12, .3, 400); },
    lap:   () => { [659, 784, 988].forEach((f, i) => tone(f, .14, 'square', .12, 0, i * .09)); },
    finish:() => { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, .2, 'square', .14, 0, i * .12)); },
  };
  function play(n){ try { init(); FX[n] && FX[n](); } catch (e) {} }
  function engine(speed, on){
    if (!eng) return; const t = now(), s = Math.max(0, Math.min(1.5, speed));
    eng.g.gain.setTargetAtTime(on ? .05 + s * .06 : 0, t, .1);
    eng.o1.frequency.setTargetAtTime(55 + s * 110, t, .08); eng.o2.frequency.setTargetAtTime(56.5 + s * 112, t, .08);
    eng.f.frequency.setTargetAtTime(500 + s * 1400, t, .1);
  }
  /* ---------- music: a bouncy island loop ---------- */
  const BASS = [48, 48, 55, 55, 53, 53, 55, 55, 45, 45, 52, 52, 53, 53, 55, 50];
  const MEL = [72, 0, 76, 79, 0, 76, 74, 72, 0, 74, 76, 0, 79, 81, 79, 76, 69, 0, 72, 76, 0, 74, 72, 69, 0, 71, 72, 74, 76, 74, 71, 67];
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  let tempo = .14, playing = false;
  function schedule(){
    if (!ac || !playing) { if (ac) nextT = ac.currentTime + .05; return; }
    while (nextT < ac.currentTime + .2){
      const d = nextT - ac.currentTime;
      if (step % 2 === 0) tone(midi(BASS[(step / 2 | 0) % 16] - 12), tempo * 1.8, 'triangle', .5, 0, d, mus);
      const m = MEL[step % 32]; if (m) tone(midi(m), tempo * .9, 'square', .16, 0, d, mus);
      if (step % 4 === 0) noise(.05, 1.1, 120, d, 1, mus); else if (step % 2 === 0) noise(.03, .35, 7000, d, 1, mus);
      nextT += tempo; step++;
    }
  }
  return {
    init, play, engine,
    music(on){ playing = on; },
    get musicOn(){ return musicOn; }, get soundOn(){ return soundOn; },
    toggleMusic(){ musicOn = !musicOn; store.set('br-music', musicOn ? '1' : '0'); if (mus) mus.gain.value = musicOn ? .22 : 0; return musicOn; },
    toggleSound(){ soundOn = !soundOn; store.set('br-sound', soundOn ? '1' : '0'); if (sfx) sfx.gain.value = soundOn ? 1 : 0; return soundOn; },
  };
})();

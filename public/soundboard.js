/**
 * Web Audio soundboard — separate graph from microphone; low master gain.
 */
(function soundboardModule(global) {
  'use strict';

  let ctx = null;
  /** @type {GainNode|null} */
  let master = null;
  let muted = false;

  function setMuted(m) {
    muted = !!m;
  }

  function isMuted() {
    return muted;
  }

  function ensure() {
    if (ctx) return ctx;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.1;
    master.connect(ctx.destination);
    return ctx;
  }

  function resume() {
    const c = ensure();
    if (c && c.state === 'suspended') {
      c.resume().catch(function () {});
    }
  }

  function beep(c, t0) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t0);
    osc.connect(g);
    g.connect(master);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.85, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    osc.start(t0);
    osc.stop(t0 + 0.16);
  }

  function buzzer(c, t0) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, t0);
    osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.35);
    osc.connect(g);
    g.connect(master);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  }

  function horn(c, t0) {
    function tone(freq, start, end) {
      const o = c.createOscillator();
      const gg = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, start);
      o.connect(gg);
      gg.connect(master);
      gg.gain.setValueAtTime(0.0001, start);
      gg.gain.exponentialRampToValueAtTime(0.7, start + 0.04);
      gg.gain.exponentialRampToValueAtTime(0.0001, end);
      o.start(start);
      o.stop(end + 0.02);
    }
    tone(340, t0, t0 + 0.22);
    tone(420, t0 + 0.18, t0 + 0.48);
  }

  function pop(c, t0) {
    const len = 0.06;
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * len)), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2200, t0);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.55, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + len + 0.02);
  }

  function alert(c, t0) {
    const freqs = [660, 880, 660, 880, 660];
    let t = t0;
    for (let i = 0; i < freqs.length; i++) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freqs[i], t);
      osc.connect(g);
      g.connect(master);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.start(t);
      osc.stop(t + 0.1);
      t += 0.1;
    }
  }

  /**
   * @param {string} id
   * @param {'local' | 'remote' | undefined} source
   */
  function play(id, source) {
    if (muted || !id) return;
    const c = ensure();
    if (!c || !master) return;
    resume();
    const t0 = c.currentTime;
    if (source === 'local') console.log('[soundboard] play local', id);
    if (source === 'remote') console.log('[soundboard] play remote', id);

    switch (id) {
      case 'beep':
        beep(c, t0);
        break;
      case 'buzzer':
        buzzer(c, t0);
        break;
      case 'horn':
        horn(c, t0);
        break;
      case 'pop':
        pop(c, t0);
        break;
      case 'alert':
        alert(c, t0);
        break;
      default:
        break;
    }
  }

  global.SoundboardSfx = {
    play,
    setMuted,
    isMuted,
  };
})(window);

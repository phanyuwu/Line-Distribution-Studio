/* ============================================================
   render-shim.js  —  lo inyecta render.js ANTES de cargar la página.
   Hace que el tiempo de la página sea "virtual": solo avanza cuando
   render.js lo pide, así cada frame sale perfecto aunque la tablet
   tarde 2 segundos en dibujarlo.

   Controla: setTimeout / setInterval / requestAnimationFrame,
   Date.now / performance.now, animaciones y transiciones CSS,
   el reloj del <audio>, los saltos del <video> del MV y el
   analizador de audio (el logo que rebota con los graves).
   ============================================================ */
(() => {
  if (window.__V) return;

  const R = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
    perfNow: performance.now.bind(performance),
    dateNow: Date.now.bind(Date),
  };

  const V = (window.__V = {
    on: false, now: 0, t0: 0, dateBase: 0, seq: 0, nextId: 1e9,
    timers: [], rafs: [], R,
    fps: 30, audioStartAt: null, pcm: null, sr: 44100,
  });
  const BIG = 1e9;
  const nowMs = () => (V.on ? V.now : R.perfNow());

  performance.now = () => nowMs();
  Date.now = () => (V.on ? V.dateBase + V.now : R.dateNow());

  /* ---------- timers virtuales ---------- */
  window.setTimeout = function (fn, delay, ...args) {
    if (!V.on || typeof fn !== 'function') return R.setTimeout(fn, delay, ...args);
    const id = V.nextId++;
    V.timers.push({ id, at: V.now + Math.max(0, +delay || 0), seq: V.seq++, fn, args, every: 0 });
    return id;
  };
  window.setInterval = function (fn, delay, ...args) {
    // El index refresca el reloj de la barra cada 60 s SIN los segundos de la canción (muestra un minuto menos
    // por un instante) y en tiempo real, no virtual. Al renderizar el reloj ya se actualiza en cada cuadro: se ignora.
    if (typeof fn === 'function' && fn.name === 'updateStatusBarTime' && +delay === 60000) return 0;
    if (!V.on || typeof fn !== 'function') return R.setInterval(fn, delay, ...args);
    const id = V.nextId++;
    const every = Math.max(1, +delay || 0);
    V.timers.push({ id, at: V.now + every, seq: V.seq++, fn, args, every });
    return id;
  };
  const clearV = (id, realFn) => {
    if (id >= BIG) { V.timers = V.timers.filter(t => t.id !== id); } else { realFn(id); }
  };
  window.clearTimeout = id => clearV(id, R.clearTimeout);
  window.clearInterval = id => clearV(id, R.clearInterval);
  window.requestAnimationFrame = function (cb) {
    if (!V.on) return R.raf(cb);
    const id = V.nextId++;
    V.rafs.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = id => {
    if (id >= BIG) V.rafs = V.rafs.filter(r => r.id !== id); else R.caf(id);
  };

  function runTimersUntil(target) {
    let guard = 0;
    for (;;) {
      let best = -1;
      for (let i = 0; i < V.timers.length; i++) {
        const t = V.timers[i];
        if (t.at <= target && (best < 0 || t.at < V.timers[best].at || (t.at === V.timers[best].at && t.seq < V.timers[best].seq))) best = i;
      }
      if (best < 0 || ++guard > 100000) break;
      const t = V.timers[best];
      V.now = Math.max(V.now, t.at);
      if (t.every) { t.at += t.every; t.seq = V.seq++; } else { V.timers.splice(best, 1); }
      try { t.fn(...t.args); } catch (e) { console.error('[timer]', e); }
    }
    V.now = Math.max(V.now, target);
  }
  function runRafs() {
    const list = V.rafs; V.rafs = [];
    for (const r of list) { try { r.cb(V.now); } catch (e) { console.error('[raf]', e); } }
  }

  /* ---------- animaciones / transiciones CSS y .animate() ---------- */
  function syncAnimations() {
    let list;
    try { list = document.getAnimations(); } catch (e) { return; }
    for (const a of list) {
      const rate = a.playbackRate || 1;
      if (a.__vs === undefined) {
        a.__vs = V.now - (Number(a.currentTime) || 0) / rate;
        try { a.pause(); } catch (e) {}
      }
      try { a.currentTime = (V.now - a.__vs) * rate; } catch (e) {}
    }
  }

  /* ---------- reloj del <audio> y control del <video> ---------- */
  V.installMedia = (opts) => {
    const a = document.getElementById('audio-player');
    const v = document.getElementById('line-bg-video');
    V.audio = a; V.video = v; V.fps = opts.fps || 30;
    const D = opts.duration;
    const A = { base: 0, at: null, ended: false };

    const settle = () => {
      if (A.at !== null && A.base + (nowMs() - A.at) / 1000 >= D) {
        A.base = D; A.at = null; A.ended = true;
        V.audioEndedAt = nowMs() - V.t0;
        window.setTimeout(() => a.dispatchEvent(new Event('ended')), 0);
      }
    };
    const cur = () => { settle(); return A.at === null ? A.base : A.base + (nowMs() - A.at) / 1000; };
    V.audioTime = cur;
    const def = (o, k, d) => Object.defineProperty(o, k, Object.assign({ configurable: true }, d));
    def(a, 'currentTime', { get: cur, set(val) { settle(); A.base = Math.max(0, +val || 0); A.ended = false; if (A.at !== null) A.at = nowMs(); } });
    def(a, 'paused', { get() { settle(); return A.at === null; } });
    def(a, 'ended', { get() { settle(); return A.ended; } });
    def(a, 'duration', { get: () => D });
    a.play = () => {
      settle();
      if (A.ended) { A.base = 0; A.ended = false; }
      if (A.at === null) {
        A.at = nowMs();
        if (A.base < 0.05) V.audioStartAt = nowMs() - V.t0; // cuándo arranca la canción dentro del video
      }
      return Promise.resolve();
    };
    a.pause = () => { const c = cur(); A.base = c; A.at = null; };

    if (v) { v.play = () => Promise.resolve(); v.pause = () => {}; }
  };

  async function syncVideo() {
    const v = V.video;
    if (!v || !(v.duration > 0) || v.readyState < 2) return;
    const cs = getComputedStyle(v);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
    // Retraso/adelanto del MV (slider del layout "Fondo y Video"): mismo cálculo que el index en vivo
    const offEl = document.getElementById('slider-mv-offset');
    const off = offEl ? (parseFloat(offEl.value) || 0) : 0;
    const t = Math.max(0, V.audioTime() + off) % v.duration;
    if (Math.abs(v.currentTime - t) < 0.5 / V.fps) return;
    let frameP = Promise.resolve();
    if (v.requestVideoFrameCallback) {
      // esperamos el cuadro nuevo (hasta 2 s) para que el fondo no parpadee con el cuadro anterior
      frameP = new Promise(res => { const to = R.setTimeout(res, 2000); v.requestVideoFrameCallback(() => { R.clearTimeout(to); res(); }); });
    }
    await new Promise(res => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
      v.addEventListener('seeked', fin);
      R.setTimeout(fin, 4000);
      v.currentTime = t;
    });
    await frameP;
  }

  /* ---------- analizador de audio emulado con el PCM real ---------- */
  V.loadPCM = async (url) => {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await (await fetch(url)).arrayBuffer();
    const ab = await ctx.decodeAudioData(buf);
    V.pcm = ab.getChannelData(0);
    V.sr = ab.sampleRate;
    return V.pcm.length;
  };

  const N = 128, BINS = N / 2;
  const COS = new Float32Array(BINS * N), SIN = new Float32Array(BINS * N), WIN = new Float32Array(N);
  for (let n = 0; n < N; n++) WIN[n] = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / N) + 0.08 * Math.cos((4 * Math.PI * n) / N);
  for (let k = 0; k < BINS; k++) for (let n = 0; n < N; n++) {
    const ang = (2 * Math.PI * k * n) / N; COS[k * N + n] = Math.cos(ang); SIN[k * N + n] = Math.sin(ang);
  }
  const smooth = new Float32Array(BINS);
  let lastKey = -1; const cache = new Uint8Array(BINS);
  if (window.AnalyserNode) {
    AnalyserNode.prototype.getByteFrequencyData = function (arr) {
      if (!V.pcm || !V.audioTime) { arr.fill(0); return; }
      const key = Math.round(nowMs() * 10);
      if (key !== lastKey) {
        lastKey = key;
        const tau = this.smoothingTimeConstant == null ? 0.8 : this.smoothingTimeConstant;
        const minDb = this.minDecibels == null ? -100 : this.minDecibels;
        const maxDb = this.maxDecibels == null ? -30 : this.maxDecibels;
        const end = Math.floor(V.audioTime() * V.sr), start = end - N, len = V.pcm.length;
        const x = new Float32Array(N);
        // Si la canción ya terminó, el navegador real recibe silencio: dejamos que todo decaiga a cero (sin temblor final)
        const silent = V.audioEndedAt !== undefined;
        for (let n = 0; n < N; n++) { const i = start + n; x[n] = !silent && i >= 0 && i < len ? V.pcm[i] * WIN[n] : 0; }
        for (let k = 0; k < BINS; k++) {
          let re = 0, im = 0;
          for (let n = 0; n < N; n++) { re += x[n] * COS[k * N + n]; im -= x[n] * SIN[k * N + n]; }
          const mag = Math.sqrt(re * re + im * im) / N;
          smooth[k] = tau * smooth[k] + (1 - tau) * mag;
          const db = 20 * Math.log10(smooth[k] + 1e-12);
          cache[k] = Math.max(0, Math.min(255, Math.round((255 * (db - minDb)) / (maxDb - minDb))));
        }
      }
      for (let i = 0; i < arr.length; i++) arr[i] = i < BINS ? cache[i] : 0;
    };
  }

  /* ---------- imágenes: precarga y espera de pintado ---------- */
  const decoded = new WeakMap(); // <img> -> src ya decodificado
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => R.setTimeout(r, ms))]);
  // Calienta la caché con todas las fotos (avatares, logo, portada...) para que los <img> que la página
  // crea después (p. ej. los avatares de la línea que se canta) salgan al instante, ya decodificados.
  V.preload = async () => {
    const urls = new Set();
    Array.from(document.images).forEach(im => { if (im.currentSrc || im.src) urls.add(im.currentSrc || im.src); });
    try { if (typeof membersData !== 'undefined') membersData.forEach(m => m && m.image && urls.add(m.image)); } catch (e) {}
    try { if (typeof allAvatarImage !== 'undefined' && allAvatarImage) urls.add(allAvatarImage); } catch (e) {}
    V._keep = [];
    await Promise.all([...urls].map(u => {
      const im = new Image(); im.src = u; V._keep.push(im); // referencia viva
      return withTimeout(im.decode ? im.decode().catch(() => {}) : Promise.resolve(), 8000);
    }));
    return urls.size;
  };
  // Antes de cada captura: decodifica imágenes nuevas y deja que Chromium pinte de verdad (2 rAF reales).
  async function settlePaint() {
    const todo = [];
    for (const im of document.images) {
      const s = im.currentSrc || im.src;
      if (!s || decoded.get(im) === s) continue;
      decoded.set(im, s);
      if (im.decode) todo.push(withTimeout(im.decode().catch(() => {}), 2000));
    }
    if (todo.length) await Promise.all(todo);
    await withTimeout(new Promise(r => R.raf(() => R.raf(r))), 500);
  }

  /* ---------- API para render.js ---------- */
  V.enable = () => {
    V.now = R.perfNow(); V.dateBase = R.dateNow() - V.now; V.t0 = V.now; V.on = true;
  };

  // Avanza dtMs de tiempo virtual y deja la página lista para la captura.
  // fast = avanzar sin preparar captura (se usa para saltar hasta un tramo de prueba)
  V.tick = async (dtMs, fast) => {
    const target = V.now + dtMs;
    runTimersUntil(target);
    runRafs();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    runTimersUntil(V.now);
    syncAnimations();
    if (!fast) {
      await syncVideo();
      await settlePaint();
    }
    return {
      t: (V.now - V.t0) / 1000,
      audio: V.audioTime ? V.audioTime() : 0,
      audioStartAt: V.audioStartAt === null ? null : V.audioStartAt / 1000,
      animsDone: !!window.__lastAnimDone,
      ended: V.audioEndedAt !== undefined,
      endedAt: V.audioEndedAt === undefined ? null : V.audioEndedAt / 1000,
    };
  };
})();

#!/usr/bin/env node
/* ============================================================
   render.js — exporta tu Line Distribution a MP4 desde Termux.

   Uso básico (te pregunta proyecto y layout con un menú):
       node render.js
   Directo:
       node render.js --proyecto "Supernova" --layout "YouTube Rosa"
   Prueba rápida de 12 s (mide velocidad y revisa que todo se vea bien):
       node render.js --prueba
   Probar un tramo concreto de la canción (tiempo de la canción, como lo oyes):
       node render.js --desde 1:30 --hasta 2:00          (sale en salida/prueba_....mp4)
       node render.js --desde 2:10                        (12 s a partir de ahí)
       node render.js --hasta 0:40                        (desde el inicio hasta el 0:40)
   Opciones: --fps 30|60  --escala 1|1.5|2  --final 7 (seg. con solo el fondo al final)
             --crf 10  --preset veryfast  --png (captura sin pérdida, más lenta; por defecto es JPEG calidad 100)  --respaldo archivo.json
             --salida nombre.mp4  --mvancho 1280  --listar
   ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const CODE = __dirname; // aquí viven render.js, render-shim.js, index.html y node_modules
// ROOT = carpeta con tus archivos (respaldo, mv, logo, fondo...). Por defecto Render_Studio del almacenamiento compartido.
const _sh = path.join(os.homedir(), 'storage', 'shared', 'Render_Studio');
const _arg = process.argv.indexOf('--carpeta');
const ROOT = _arg > -1 && process.argv[_arg + 1] ? path.resolve(process.argv[_arg + 1])
  : (/^\/(storage|sdcard)/.test(CODE) ? CODE : (fs.existsSync(_sh) ? _sh : CODE));
const CACHE = path.join(os.homedir(), 'render_cache');
const OUTDIR = path.join(ROOT, 'salida');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUTDIR, { recursive: true });

/* ---------- utilidades ---------- */
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2), n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const fail = (m) => { console.error('\n❌ ' + m + '\n'); process.exit(1); };
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim();
const slug = (s) => norm(s).replace(/ /g, '_') || 'video';
const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + 'h ' : '') + m + 'm ' + (s % 60) + 's'; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, a, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, a, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} terminó con código ${code}`))));
  });
}
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
  let j = {}; try { j = JSON.parse(r.stdout || '{}'); } catch (e) {}
  const types = (j.streams || []).map((s) => s.codec_type);
  return { duration: parseFloat(j.format && j.format.duration) || 0, hasAudio: types.includes('audio'), hasVideo: types.includes('video') };
}

let rl = null;
const ask = (q) => new Promise((res) => { rl = rl || readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, res); });

/* ---------- respaldo (.json exportado desde tu página) ---------- */
function findBackup() {
  if (args.respaldo && args.respaldo !== true) return path.resolve(args.respaldo);
  const buscar = (d) => {
    let best = null, files = [];
    try { files = fs.readdirSync(d); } catch (e) {}
    for (const f of files) {
      if (!/^respaldo.*\.json$/i.test(f)) continue;
      const p = path.join(d, f), m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
    return best;
  };
  // Primero solo Render_Studio; Descargas únicamente si ahí no hay ninguno (esa carpeta puede ser lenta)
  let best = buscar(ROOT);
  if (!best) { console.log('   (no hay respaldo en Render_Studio, buscando en Descargas...)'); best = buscar(path.join(os.homedir(), 'storage', 'downloads')); }
  if (!best) fail('No encontré el respaldo. Descárgalo con "📤 Respaldar todo" en tu página y déjalo en Render_Studio (el nombre debe empezar con RESPALDO).');
  return best.p;
}

async function pick(title, names, wanted, allowNone) {
  if (wanted && wanted !== true) {
    const w = norm(wanted);
    const m = names.find((n) => norm(n) === w) || names.find((n) => norm(n).includes(w));
    if (!m) fail(`No encontré "${wanted}". Opciones: ${names.join(' | ')}`);
    return m;
  }
  if (!names.length) return null;
  console.log('\n' + title);
  if (allowNone) console.log('  0) (ninguno)');
  names.forEach((n, i) => console.log(`  ${i + 1}) ${n}`));
  for (;;) {
    const a = parseInt(await ask('Número: '), 10);
    if (allowNone && a === 0) return null;
    if (a >= 1 && a <= names.length) return names[a - 1];
    console.log('  Número no válido.');
  }
}

/* ---------- archivos: carpeta del proyecto > comun > raíz ---------- */
const EXT = {
  mv: ['mp4', 'webm', 'mov', 'mkv', 'm4v'],
  audio: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus'],
  fondo: ['jpg', 'jpeg', 'png', 'webp'],
  logo: ['png', 'webp', 'jpg', 'jpeg'],
  portada: ['jpg', 'jpeg', 'png', 'webp'],
};
function findProjectDir(projName) {
  const base = path.join(ROOT, 'proyectos');
  let list = []; try { list = fs.readdirSync(base); } catch (e) {}
  const pn = norm(projName);
  let hit = list.find((n) => norm(n) === pn);
  if (!hit) { // coincidencia parcial, solo si es única (ej. carpeta "Supernova" para el proyecto "Supernova - aespa")
    const parcial = list.filter((n) => norm(n) && (pn.includes(norm(n)) || norm(n).includes(pn)));
    if (parcial.length === 1) hit = parcial[0];
  }
  return hit ? path.join(base, hit) : null;
}
function findMedia(kind, projDir) {
  const dirs = [projDir, path.join(ROOT, 'comun'), ROOT].filter(Boolean);
  for (const d of dirs) {
    let list = []; try { list = fs.readdirSync(d); } catch (e) { continue; }
    const low = list.map((n) => n.toLowerCase());
    for (const e of EXT[kind]) {
      const i = low.indexOf(`${kind}.${e}`);
      if (i >= 0) return { path: path.join(d, list[i]), where: path.relative(ROOT, d) || '(carpeta principal)' };
    }
  }
  return null;
}

/* ---------- MV: se convierte UNA vez a un formato fácil de "saltar" cuadro a cuadro ---------- */
async function prepareMV(mvPath, width) {
  const st = fs.statSync(mvPath);
  const key = crypto.createHash('md5').update(`${mvPath}|${st.size}|${st.mtimeMs}|${width}`).digest('hex').slice(0, 10);
  const out = path.join(CACHE, `mv_${key}.webm`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) { console.log('🎞️  MV ya preparado antes (se reutiliza).'); return out; }
  console.log('🎞️  Preparando el MV (solo la primera vez por video)...');
  const tmp = out + '.part';
  await run('ffmpeg', ['-y', '-v', 'error', '-stats', '-i', mvPath, '-an',
    '-vf', `scale='min(${width},iw)':-2`,
    '-c:v', 'libvpx', '-b:v', '8M', '-crf', '10', '-g', '8', '-deadline', 'realtime', '-cpu-used', '8',
    '-lag-in-frames', '0', '-auto-alt-ref', '0', '-pix_fmt', 'yuv420p', '-f', 'webm', tmp]);
  fs.renameSync(tmp, out);
  return out;
}

/* ============================================================ */
(async () => {
  console.log('▶ Iniciando...\n   programa: ' + CODE + '\n   tus archivos: ' + ROOT);
  const backupPath = findBackup();
  console.log('📦 Respaldo:', path.basename(backupPath));
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const projects = backup.projects || {}, layouts = backup.layouts || {};
  const pNames = Object.keys(projects), lNames = Object.keys(layouts);
  if (!pNames.length) fail('El respaldo no tiene proyectos.');
  if (args.listar) { console.log('\nProyectos:\n - ' + pNames.join('\n - ') + '\n\nLayouts:\n - ' + (lNames.join('\n - ') || '(ninguno)')); process.exit(0); }

  const projName = await pick('¿Qué proyecto quieres exportar?', pNames, args.proyecto, false);
  const layName = lNames.length ? await pick('¿Qué layout usar?', lNames, args.layout, true) : null;
  if (rl) rl.close();
  const project = projects[projName];
  const layout = layName ? layouts[layName] : {};
  console.log(`\n🎵 Proyecto: ${projName}\n🎨 Layout:   ${layName || '(ninguno)'}  [${layout.mode || 'youtube'}]`);

  /* --- archivos --- */
  const projDir = findProjectDir(projName);
  const f = { mv: findMedia('mv', projDir), audio: findMedia('audio', projDir), fondo: findMedia('fondo', projDir), logo: findMedia('logo', projDir), portada: findMedia('portada', projDir) };
  console.log('\n📁 Archivos' + (projDir ? ` (carpeta del proyecto: proyectos/${path.basename(projDir)})` : '') + ':');
  const line = (n, x, miss) => console.log(`   ${x ? '✔' : '✖'} ${n.padEnd(8)} ${x ? x.where + '/' + path.basename(x.path) : miss}`);
  line('mv', f.mv, 'no hay → la ventana del MV saldrá vacía');
  line('audio', f.audio, f.mv ? 'no hay → se usa el audio del mv' : 'no hay');
  line('fondo', f.fondo, 'no hay → se usa el que traiga el layout');
  line('logo', f.logo, 'no hay → el logo saldrá vacío');
  line('portada', f.portada, 'no hay → se usa la del layout / por defecto');
  if (!f.fondo && /^blob:/.test((layout.wallpaper && layout.wallpaper.url) || '')) console.log('   ⚠️ el fondo del layout era un archivo subido a mano (ya no existe). Pon fondo.jpg.');
  if (!f.portada && /^blob:/.test((layout.playerCover && layout.playerCover.url) || '')) console.log('   ⚠️ la portada del layout era un archivo subido a mano. Pon portada.jpg.');

  /* --- audio: archivo propio o el del MV --- */
  let audioSrc = f.audio && f.audio.path;
  if (!audioSrc && f.mv && probe(f.mv.path).hasAudio) { audioSrc = f.mv.path; console.log('\n🔊 Audio: se toma del MV.'); }
  else if (audioSrc) console.log('\n🔊 Audio: archivo propio (se ignora el sonido del MV).');
  if (!audioSrc) fail('No hay audio: pon audio.mp3 (o un mv con sonido).');
  const wav = path.join(CACHE, 'audio_render.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', audioSrc, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', wav]);
  const duration = probe(wav).duration;
  if (!duration) fail('No pude leer la duración del audio.');

  const tiktokPre = layout.mode === 'tiktok';
  const fps = parseInt(args.fps, 10) || 30;
  const scale = parseFloat(args.escala) || 1; // 1 = Full HD exacto
  const finalHold = args.final && args.final !== true ? parseFloat(args.final) : 7;
  const TAIL = 16; // canción termina -> gráfica 10 s + cierre de ventanas/dock ≈ 15 s
  const testSecs = args.prueba ? (args.prueba === true ? 12 : parseFloat(args.prueba)) : 0;
  // Tramo de prueba: --desde / --hasta en tiempo de la canción ("90", "1:30" o "0:01:30")
  const parseT = (v) => {
    if (v === undefined) return null;
    if (v === true) fail('Después de --desde / --hasta pon un tiempo, por ejemplo 1:30');
    const p = String(v).trim().split(':').map(Number);
    if (!p.length || p.some((x) => !isFinite(x) || x < 0)) fail(`No entendí el tiempo "${v}". Usa segundos (90) o minutos:segundos (1:30).`);
    return p.reduce((a, x) => a * 60 + x, 0);
  };
  const tFmt = (s) => { s = Math.round(s); return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's'; };
  let rangeFrom = parseT(args.desde), rangeTo = parseT(args.hasta);
  const rangeMode = rangeFrom !== null || rangeTo !== null;
  if (rangeMode) {
    if (rangeFrom !== null && rangeFrom >= duration) fail(`--desde ${tFmt(rangeFrom)} cae después del final de la canción (${tFmt(duration)}).`);
    if (rangeTo === null) rangeTo = rangeFrom + 12;
    rangeTo = Math.min(rangeTo, duration);
    if (rangeFrom !== null && rangeTo <= rangeFrom) fail('--hasta debe ser mayor que --desde.');
  }
  const mvWidth = parseInt(args.mvancho, 10) || (tiktokPre ? 1080 : 1920);
  const mvFile = f.mv ? await prepareMV(f.mv.path, mvWidth) : null;

  /* --- servidor local --- */
  const express = require('express');
  const app = express();
  const files = { 'audio.wav': wav };
  if (mvFile) files['mv.webm'] = mvFile;
  if (f.fondo) files['fondo' + path.extname(f.fondo.path)] = f.fondo.path;
  if (f.logo) files['logo' + path.extname(f.logo.path)] = f.logo.path;
  if (f.portada) files['portada' + path.extname(f.portada.path)] = f.portada.path;
  app.get('/f/:name', (req, res) => (files[req.params.name] ? res.sendFile(files[req.params.name], { dotfiles: 'allow' }) : res.sendStatus(404)));
  app.use(express.static(CODE, { index: false }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://localhost:${server.address().port}`;
  const U = (k) => { const n = Object.keys(files).find((x) => x.startsWith(k)); return n ? `${base}/f/${n}` : undefined; };

  /* --- navegador --- */
  const puppeteer = require('puppeteer-core');
  // 'new' en versiones 19-21; desde la 22 el modo nuevo es simplemente true ('new' queda obsoleto)
  let HEADLESS = 'new';
  try { if (parseInt(require('puppeteer-core/package.json').version, 10) >= 22) HEADLESS = true; } catch (e) {}
  const chrome = process.env.CHROMIUM_PATH || ['/data/data/com.termux/files/usr/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(fs.existsSync);
  if (!chrome) fail('No encuentro Chromium. En Termux: pkg install x11-repo && pkg install chromium');
  const tiktok = layout.mode === 'tiktok';
  const W = tiktok ? 1080 : 1920, H = tiktok ? 1920 : 1080; // Full HD (la página escala el canvas sola)
  console.log(`\n🚀 Abriendo navegador invisible (${W}x${H}, escala ${scale}, ${fps} fps)...`);
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: HEADLESS, defaultViewport: null,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gl-drawing-for-tests', '--autoplay-policy=no-user-gesture-required',
      '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const cleanup = async () => { try { await browser.close(); } catch (e) {} try { server.close(); } catch (e) {} };
  process.on('SIGINT', async () => { console.log('\n⏹️  Cancelado.'); await cleanup(); process.exit(130); });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: scale });
    page.on('dialog', (d) => { console.log('   ⚠️ La página avisó:', d.message()); d.dismiss().catch(() => {}); });
    page.on('pageerror', (e) => console.log('   ⚠️ Error en la página:', String(e.message || e).slice(0, 200)));
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(CODE, 'render-shim.js'), 'utf8'));

    console.log('🌐 Cargando la página (necesita internet: Tailwind y fuentes de Google)...');
    await page.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('typeof window.prepareForRender === "function" && !!document.getElementById("os-canvas")', { timeout: 60000 });
    await sleep(1500);

    console.log('⚙️  Cargando proyecto y layout...');
    await page.addStyleTag({ content: 'canvas, img, video, .member-bar, #header-logo-img { image-rendering: auto !important; }' }); // escalado de alta calidad (crisp-edges/optimize-contrast pixelan al reducir); solo en el render
    const info = await page.evaluate((cfg) => window.prepareForRender(cfg), {
      project, layout,
      urls: { audio: U('audio'), mv: U('mv'), wallpaper: U('fondo'), logo: U('logo'), cover: U('portada') },
    });
    if (f.mv && !info.mvOk) console.log('   ⚠️ Chromium no pudo abrir el MV; saldrá sin video de fondo.');
    // Si el respaldo trae los bloques del editor, la página los usa para el 2º anillo (cantar varias a la vez)
    if (Array.isArray(project.editorSegments)) {
      await page.evaluate((segs) => { try { currentEditorSegments = segs; } catch (e) {} }, project.editorSegments);
    }
    await page.evaluate(() => window.__V.preload()); // fotos ya decodificadas: los avatares no parpadean
    await page.evaluate((u) => window.__V.loadPCM(u), U('audio'));
    await sleep(1500);
    await page.evaluate((o) => { window.__V.enable(); window.__V.installMedia(o); window.startRenderSequence(); }, { fps, duration });

    /* --- ffmpeg recibe los cuadros --- */
    const silent = path.join(CACHE, 'video_sin_audio.mp4');
    const png = !!args.png; // por defecto JPEG calidad 100 (≈2× más rápido); --png = sin pérdida, más lento
    const vf = `scale=${W}:${H}:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,format=yuv420p`;
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', png ? 'png' : 'mjpeg', '-i', '-',
      '-vf', vf, '-c:v', 'libx264', '-preset', (args.preset && args.preset !== true) ? args.preset : 'veryfast',
      '-profile:v', 'high', '-level', fps > 30 ? '4.2' : '4.1',
      '-crf', String(parseInt(args.crf, 10) || 10), '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-movflags', '+faststart', silent], { stdio: ['pipe', 'inherit', 'inherit'] });
    let ffErr = null;
    const ffDone = new Promise((res) => ff.on('close', (c) => res(c)));
    ff.on('error', (e) => { ffErr = e; });
    ff.stdin.on('error', (e) => { ffErr = e; });

    const dt = 1000 / fps;
    const intro = 1 + info.recordingDelay + 0.45;
    let st = { t: 0, ended: false, animsDone: false, audioStartAt: null, endedAt: null };
    let animsDoneAt = null;
    let frame = 0, lastLog = -1;
    const started = Date.now();
    let startAudio = 0; // segundo de la canción en que empieza el video (modo --desde)
    if (rangeMode && rangeFrom !== null) {
      // Adelanta el reloj virtual SIN tomar capturas hasta llegar al tramo pedido (rápido, pero la página corre completa)
      console.log(`\n⏩ Avanzando hasta ${tFmt(rangeFrom)} de la canción (sin capturar)...`);
      let lastP = -1;
      for (;;) {
        const near = st.audio >= rangeFrom - 1.5;
        st = await page.evaluate((d, fast) => window.__V.tick(d, fast), near ? dt : 200, !near);
        if (st.audio >= rangeFrom) break;
        const p = Math.floor((st.audio / rangeFrom) * 10);
        if (p !== lastP) { lastP = p; console.log(`   ${p * 10}%`); }
        if (st.t > rangeFrom + 600) throw new Error('No logré llegar al tramo pedido (¿la canción no arrancó?).');
      }
      startAudio = st.audio;
    }
    const testTotal = rangeMode ? (rangeFrom !== null ? rangeTo - startAudio : intro + rangeTo) : testSecs;
    console.log(`\n🎬 Renderizando${rangeMode ? ` PRUEBA del tramo ${rangeFrom !== null ? tFmt(startAudio) : 'inicio'} → ${tFmt(rangeTo)}` : (testSecs ? ` PRUEBA de ${testSecs}s` : '')} — canción de ${fmt(duration)}...\n`);
    for (;;) {
      const shot = await page.screenshot({ type: png ? 'png' : 'jpeg', quality: png ? undefined : 100, captureBeyondViewport: false, optimizeForSpeed: png });
      if (ffErr) throw ffErr;
      if (!ff.stdin.write(shot)) await new Promise((r) => ff.stdin.once('drain', r));
      frame++;
      const tSec = frame / fps;

      const expected = (st.audioStartAt == null ? intro : st.audioStartAt) + duration + TAIL + finalHold;
      const sec = Math.floor(tSec);
      if (sec !== lastLog && sec % 2 === 0) {
        lastLog = sec;
        const el = (Date.now() - started) / 1000, total = testTotal || expected;
        const eta = el / tSec * Math.max(0, total - tSec);
        console.log(`⏳ ${Math.min(100, Math.round(tSec / total * 100))}%  video ${fmt(tSec)} / ${fmt(total)}  · ${(el / frame).toFixed(2)} s por cuadro · faltan ~${fmt(eta)}`);
      }
      if (testSecs && tSec >= testSecs) break;
      if (rangeMode && st.audio >= rangeTo) break;
      if (st.animsDone && animsDoneAt === null) animsDoneAt = tSec;
      if (animsDoneAt !== null && tSec >= animsDoneAt + finalHold) break;
      if (tSec > expected + 30) { console.log('⚠️ No detecté el final de las animaciones; se corta aquí.'); break; }
      st = await page.evaluate((d) => window.__V.tick(d), dt);
    }
    ff.stdin.end();
    const code = await ffDone;
    if (code !== 0) throw new Error('ffmpeg falló al armar el video (código ' + code + ')');

    /* --- audio: se coloca en el segundo exacto en que la página arrancó la canción --- */
    const videoDur = frame / fps;
    const delayMs = Math.round((st.audioStartAt == null ? intro : st.audioStartAt) * 1000);
    const fromStart = rangeMode && rangeFrom !== null; // el video ya empieza dentro de la canción: se recorta el audio, sin retraso
    const outName = rangeMode ? `prueba_${rangeFrom !== null ? tFmt(startAudio) : '0m00s'}-${tFmt(rangeTo)}.mp4`
      : testSecs ? 'prueba.mp4' : (args.salida && args.salida !== true ? args.salida : `${slug(projName)}${layName ? '_' + slug(layName) : ''}.mp4`);
    const outPath = path.join(OUTDIR, outName);
    console.log(fromStart ? `\n🔊 Uniendo audio (desde ${startAudio.toFixed(2)} s de la canción)...` : `\n🔊 Uniendo audio (entra en el segundo ${(delayMs / 1000).toFixed(2)})...`);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', silent, ...(fromStart ? ['-ss', startAudio.toFixed(3)] : []), '-i', audioSrc, '-map', '0:v:0', '-map', '1:a:0',
      ...(fromStart ? [] : ['-af', `adelay=${delayMs}:all=1`]), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-t', videoDur.toFixed(3), '-movflags', '+faststart', outPath]);

    const secs = (Date.now() - started) / 1000;
    console.log(`\n🎉 LISTO → salida/${outName}  (${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB, ${fmt(videoDur)} de video)`);
    console.log(`   Tardó ${fmt(secs)} (${(secs / frame).toFixed(2)} s por cuadro).`);
    if (testSecs && !rangeMode) console.log(`   Un video completo de ${fmt(intro + duration + TAIL + finalHold)} tardaría unas ${fmt(secs / frame * (intro + duration + TAIL + finalHold) * fps)}.`);
  } catch (e) {
    console.error('\n❌ ERROR:', e && e.message ? e.message : e);
    await cleanup(); process.exit(1);
  }
  await cleanup();
  process.exit(0);
})();

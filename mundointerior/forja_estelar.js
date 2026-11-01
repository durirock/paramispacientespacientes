/* ==========================================================================
   FORJA ESTELAR · núcleo de integración para MUNDO INTERIOR
   Chamalnquimyst Labs

   Mismo patrón que Aureum Seres en Musicosmos: se engancha a los globales del
   script principal (scene, camera, webglRenderer, avatarObject, yawAngle,
   pitchAngle, zoomDistance, isFocused, moveForward...) y expone window.Forja.
   Mundo Interior lo llama en cuatro puntos: animate(), render, ratón y teclado.

   Requiere, en este orden: forja_soles.js, forja_kairos.js, forja_estelar.js
   (y los scripts de postprocesado de three r128 si querés el halo de plasma).

   Teclas:  C orbitar · Shift+C / Esc salir · Enter zoom al video más cercano
            Espacio pausa el video en zoom · W/S acercarse · A/D/Q/E girar
   ========================================================================== */
(function () {
  'use strict';
  if (typeof THREE === 'undefined' || typeof scene === 'undefined' || typeof camera === 'undefined') {
    console.warn('[Forja] No encuentro la escena de Mundo Interior. Cargá este archivo después del script principal.');
    return;
  }
  const L = window.ForjaLib;
  if (!L || !L.KairosStar || !L.AudioSun) {
    console.warn('[Forja] Faltan forja_soles.js y/o forja_kairos.js antes de forja_estelar.js');
    return;
  }

  const V3 = THREE.Vector3;
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  const DB = L.DB, HUES = L.HUES;

  const CFG = {
    maxLiveVideos: 2,       // videos en miniatura reproduciéndose a la vez
    liveDist: 70,           // bajo esta distancia el video se reproduce en miniatura
    flipDist: 210,          // bajo esta distancia se ve la secuencia de fotogramas
    flipFps: 2.5,
    spawnDist: 48,          // a qué distancia nace un Kairós frente a vos
    orbitMax: 900,
    radarRanges: [150, 400, 1000]
  };
  const COLORS = { kairos: '#00e8c8', sun: '#ffd34d', tagua: '#ff6fa8' };

  /* ---------------- preferencias persistentes ---------------- */
  const PREF_KEY = 'forja_prefs_v1';
  const prefs = Object.assign({
    bloom: !isTouch, radar: true, radarRange: 1, radarMini: false,
    refDistance: 18, influence: 220, radioInfluence: 320, sunVolume: 1, taguaVolume: 1,
    pulse: 4, notif: false
  }, safeJSON(localStorage.getItem(PREF_KEY)));
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function safeJSON(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }

  const sunConfig = {
    pulse: prefs.pulse, pulseSpeed: 0.010, rotation: 0.0012, coreBrightness: 0.6,
    colorAudio: 0.3, coreColorSpeed: 0.18, outerColorSpeed: 0.10
  };

  /* ---------------- audio espacial ---------------- */
  const listener = new THREE.AudioListener();
  camera.add(listener);
  const ctx = listener.context;
  function wake() { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); }
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake);

  /* ---------------- halo de plasma (bloom) ---------------- */
  let composer = null, bloomPass = null;
  try {
    if (THREE.EffectComposer && THREE.UnrealBloomPass) {
      composer = new THREE.EffectComposer(webglRenderer);
      if (composer.setPixelRatio) composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.9, 0.55, 0.62);
      composer.addPass(bloomPass);
    }
  } catch (e) { console.warn('[Forja] Sin halo de plasma:', e); composer = null; }
  window.addEventListener('resize', () => {
    if (composer) composer.setSize(innerWidth, innerHeight);
    layoutRadar();
  });

  /* ---------------- estado ---------------- */
  const entities = [];            // { id, kind:'kairos'|'sun'|'tagua', name, hue, obj, radius }
  const msgs = new Map();          // id -> mensaje
  const blobCache = new Map();     // id -> Blob
  const urlCache = new Map();      // id -> objectURL
  let orbit = null, zoom = null, flight = null;
  let ringEnt = null, rec = null, play = null;
  let hovered = null, pointerXY = null;
  let frame = 0;
  const clockT = new THREE.Clock();
  const uid = p => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const roman = n => { const R = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of R) while (n >= v) { s += r; n -= v; } return s; };
  const T = s => s + '︎'; // fuerza glifo de texto (sin emoji) en iOS/Android

  async function getBlob(id) {
    if (blobCache.has(id)) return blobCache.get(id);
    const r = await DB.get('blobs', id);
    if (r && r.blob) blobCache.set(id, r.blob);
    return r ? r.blob : null;
  }
  async function getURL(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const b = await getBlob(id);
    if (!b) return null;
    const u = URL.createObjectURL(b);
    urlCache.set(id, u);
    return u;
  }
  function dropBlob(id) {
    blobCache.delete(id);
    if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
    return DB.del('blobs', id).catch(() => {});
  }

  /* ---------------- cámara / huésped ---------------- */
  function camForward() { const f = new V3(); camera.getWorldDirection(f); return f; }
  function spotAhead(dist) { return camera.position.clone().add(camForward().multiplyScalar(dist)); }
  /* un lugar libre frente a vos: se aleja si choca con un panel de Mundo Interior u otra estrella */
  function freeSpot(dist, clearance) {
    let p = spotAhead(dist);
    for (let i = 0; i < 6; i++) {
      const panelHit = (typeof draggableObjects !== 'undefined' ? draggableObjects : []).some(o => o.position.distanceTo(p) < clearance);
      const starHit = entities.some(e => e.obj.position.distanceTo(p) < clearance + e.radius);
      if (!panelHit && !starHit) break;
      dist += clearance * 1.2; p = spotAhead(dist);
    }
    return p;
  }
  function releaseHostFocus() {
    try {
      if (isFocused) exitFocusMode();
      isFocused = false; isTransitioning = false; focusedObject = null;
      if (typeof blocker !== 'undefined') blocker.style.pointerEvents = 'none';
    } catch (e) {}
  }
  /* devuelve la cámara al avatar de Mundo Interior sin saltos */
  function syncHostToCamera() {
    const f = camForward();
    const yaw = Math.atan2(-f.x, -f.z), pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
    yawAngle = yaw; pitchAngle = pitch;
    avatarObject.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    avatarObject.position.copy(camera.position).addScaledVector(f, zoomDistance);
  }

  /* =====================================================================
     ENTIDADES
     ===================================================================== */
  function nextKairosName() { return 'Kairós ' + roman(entities.filter(e => e.kind === 'kairos').length + 1); }

  function spawnKairos(rec) {
    const obj = new L.KairosStar(scene, new V3().fromArray(rec.position), rec.hue);
    const e = Object.assign({}, rec, { obj, radius: obj.radius });
    obj.hit.userData.ent = e;
    entities.push(e);
    return e;
  }
  async function createKairos(name, hue) {
    const rec = { id: uid('k'), kind: 'kairos', name: (name || '').trim() || nextKairosName(), hue: hue || 'calipso',
      createdAt: Date.now(), position: freeSpot(CFG.spawnDist, 26).toArray() };
    await DB.put('entities', rec);
    const e = spawnKairos(rec);
    e.obj.flash();
    toast(e.name + ' se encendió frente a vos');
    refreshUI();
    return e;
  }

  /* =====================================================================
     SOLES DE AUDIO Y RADIOS — influjo por distancia
     Dentro del "alcance pleno" suenan a todo volumen; desde ahí se apagan
     suavemente hasta el borde de su influjo. Afuera dejan de transmitir:
     el mp3 se pausa (recuerda dónde iba) y la radio corta el stream.
     Al volver a entrar retoman solos.
     ===================================================================== */
  function influenceOf(e) { return e.kind === 'tagua' ? prefs.radioInfluence : prefs.influence; }
  function baseVolOf(e) { return e.kind === 'tagua' ? prefs.taguaVolume : prefs.sunVolume; }
  function cleanRec(e) {
    const r = { id: e.id, kind: e.kind, name: e.name, createdAt: e.createdAt || Date.now(), position: e.obj.anchor.toArray() };
    if (e.blobId) r.blobId = e.blobId;
    if (e.url) r.url = e.url;
    return r;
  }
  function persistEnt(e) {
    if (e.kind === 'kairos') return DB.put('entities', Object.assign({ id: e.id, kind: e.kind, name: e.name, hue: e.hue, createdAt: e.createdAt }, { position: e.obj.position.toArray() })).catch(() => {});
    return DB.put('entities', cleanRec(e)).catch(() => {});
  }

  function spawnSun(rec) {
    const obj = new L.AudioSun({ scene, position: new V3().fromArray(rec.position), kind: rec.kind === 'tagua' ? 'tagua' : 'mp3',
      ctx, listener, config: sunConfig });
    const e = Object.assign({}, rec, { obj, radius: obj.radius, armed: false, inside: true, pending: false, status: 'detenido' });
    obj.setPanner(prefs.refDistance, influenceOf(e));
    obj.setVolume(baseVolOf(e));
    obj.setFade(0);
    obj.hit.userData.ent = e;
    obj.el.addEventListener('ended', () => { e.obj.playing = false; e.armed = false; e.status = 'detenido'; refreshUI(); });
    obj.el.addEventListener('error', () => {
      if (!e.obj.el.getAttribute('src')) return;
      e.obj.playing = false;
      if (e.kind === 'tagua') { e.armed = false; e.status = 'sin conexión con el stream'; toast(e.name + ': no pude conectar con el stream'); }
      refreshUI();
    });
    entities.push(e);
    return e;
  }

  /* arranca o retoma el sonido de un sol/radio (sin tocar la intención del usuario) */
  async function startSound(e) {
    if (e.pending) return;
    e.pending = true;
    try {
      if (e.kind === 'tagua') {
        e.status = 'conectando...'; refreshUI();
        e.obj.setSource(e.url || L.TAGUA_URL, false);
      } else if (!e.obj.el.getAttribute('src')) {
        const u = await getURL(e.blobId || e.id);
        if (!u) { toast('Este sol perdió su archivo de audio'); e.armed = false; return; }
        e.obj.setSource(u, true);
      }
      await e.obj.play();
      e.status = e.kind === 'tagua' ? 'en el aire' : 'cantando';
    } catch (err) {
      e.obj.playing = false;
      if (e.armed) { e.armed = false; e.status = 'no pude reproducir (' + (err && err.name || 'error') + ')'; toast(e.name + ': no pude reproducir'); }
    } finally { e.pending = false; refreshUI(); }
  }
  function suspendSound(e, why) {
    if (e.kind === 'tagua') e.obj.stopStream(); else e.obj.pause();
    e.status = why || 'detenido';
    refreshUI();
  }
  async function toggleSun(e, forcePlay) {
    wake();
    if (e.armed && !forcePlay) {
      e.armed = false; suspendSound(e, 'detenido');
      toast(e.name + (e.kind === 'tagua' ? ' fuera del aire' : ' en silencio'));
      return;
    }
    e.armed = true;
    const d = camera.position.distanceTo(e.obj.position);
    if (d > influenceOf(e)) {
      e.inside = false; e.status = 'esperando: fuera de su influjo';
      toast(e.name + ' encendido · se oirá al entrar en su influjo');
      refreshUI(); return;
    }
    e.inside = true;
    await startSound(e);
    if (e.obj.playing) toast(e.kind === 'tagua' ? e.name + ' en el aire' : e.name + ' canta');
  }

  /* corre cada pocos cuadros: volumen por distancia y corte por influjo */
  function updateInfluence() {
    const cam = camera.position;
    for (const e of entities) {
      if (e.kind === 'kairos') continue;
      const inf = influenceOf(e), d = cam.distanceTo(e.obj.position);
      const ref = Math.min(prefs.refDistance, inf * 0.5);
      // apagado suave en el último 40 % del influjo
      const edge = inf * 0.6;
      let fade = d <= edge ? 1 : Math.max(0, 1 - (d - edge) / (inf - edge));
      fade = fade * fade * (3 - 2 * fade);
      e.obj.setFade(fade);
      e.fade = fade; e.dist = d;
      if (!e.armed) continue;
      if (e.inside && d > inf * 1.05) {
        e.inside = false;
        if (e.obj.playing) suspendSound(e, 'fuera de su influjo');
        else e.status = 'fuera de su influjo';
      } else if (!e.inside && d < inf) {
        e.inside = true;
        startSound(e);
      }
    }
  }

  async function createSunsFromFiles(files) {
    const list = Array.from(files || []).filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name));
    if (!list.length) { toast('No encontré archivos de audio'); return; }
    const f = camForward(); const right = new V3().crossVectors(f, new V3(0, 1, 0)).normalize();
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const pos = (i === 0 ? freeSpot(80, 30) : spotAhead(80)).addScaledVector(right, (i - (list.length - 1) / 2) * 70);
      const id = uid('s');
      const rec = { id, kind: 'sun', name: file.name.replace(/\.[^.]+$/, ''), createdAt: Date.now(), position: pos.toArray(), blobId: id };
      await DB.put('blobs', { id, blob: file });
      await DB.put('entities', rec);
      blobCache.set(id, file);
      const e = spawnSun(rec);
      e.obj.setSource(await getURL(id), true);
      if (i === 0) await toggleSun(e, true);
    }
    toast(list.length > 1 ? list.length + ' soles encendidos' : 'Un sol nuevo canta frente a vos');
    refreshUI();
  }

  /* ---------------- radios (se pueden forjar varias) ---------------- */
  function radios() { return entities.filter(e => e.kind === 'tagua'); }
  async function createRadio(name, url, play) {
    url = (url || '').trim() || L.TAGUA_URL;
    if (!/^https?:\/\//i.test(url)) { toast('La dirección del stream debe empezar con http(s)://'); return null; }
    const n = radios().length;
    const rec = { id: uid('r'), kind: 'tagua', name: (name || '').trim() || (n ? 'Radio Tagua Tagua ' + roman(n + 1) : 'Radio Tagua Tagua'),
      url, createdAt: Date.now(), position: freeSpot(120, 40).toArray() };
    await DB.put('entities', rec);
    const e = spawnSun(rec);
    toast(e.name + ' forjada frente a vos');
    if (play) await toggleSun(e, true);
    refreshUI();
    return e;
  }
  function bringHere(e) {
    e.obj.anchor.copy(freeSpot(110, 40));
    persistEnt(e);
    toast(e.name + ' ahora brilla frente a vos'); refreshUI();
  }

  /* ---------------- mensajes de Kairós ---------------- */
  function attachSat(k, m) {
    const s = k.obj.addSatellite(m);
    s.pick.userData.ent = k;
    if (m.orbit) { s.radius = m.orbit.r; s.height = m.orbit.h; s.angle = m.orbit.a; k.obj._placeSat(s); }
    if (m.type === 'video') queueFrames(k, s);
    if (m.bounces && m.bounces.some(b => b.arrived && !b.opened)) k.obj.markArrived(m.id, true);
    return s;
  }
  async function commitMessage(k, data) {
    const id = uid('m');
    const m = { id, kairosId: k.id, type: data.type, text: data.text || '', name: data.name || '', createdAt: Date.now(), bounces: [] };
    if (data.blob) { await DB.put('blobs', { id, blob: data.blob }); blobCache.set(id, data.blob); }
    await DB.put('messages', m);
    msgs.set(id, m);
    attachSat(k, m);
    if (data.type === 'voice') k.obj.absorb(); else k.obj.feed();
    k.obj.setResonance(countFor(k).total);
    toast(data.type === 'voice' ? 'Tu voz quedó integrada al núcleo ' + T('✦')
      : data.type === 'video' ? 'El video ya orbita ' + k.name : 'Tu mensaje quedó suspendido en el plasma ' + T('✦'));
    refreshUI();
    return m;
  }
  async function deleteMessage(id) {
    const m = msgs.get(id); if (!m) return;
    const k = entities.find(e => e.id === m.kairosId);
    if (zoom && zoom.sat.msgId === id) unzoom(true);
    if (k) { const s = k.obj.removeSatellite(id); if (s) releaseLive(s); }
    msgs.delete(id);
    await DB.del('messages', id).catch(() => {});
    await dropBlob(id);
    refreshUI();
  }
  async function deleteEntity(e) {
    if (orbit && orbit.ent === e) exitOrbit();
    if (zoom && zoom.ent === e) unzoom(true);
    if (ringEnt === e) closeRing();
    if (play && play.ent === e) stopPlayback();
    if (e.kind === 'kairos') {
      for (const m of [...msgs.values()].filter(m => m.kairosId === e.id)) await deleteMessage(m.id);
      if (e.chain) { e.chain.el.pause(); try { e.chain.pa.disconnect(); } catch (err) {} }
    }
    if (e.kind === 'sun') await dropBlob(e.blobId || e.id);
    e.obj.dispose();
    entities.splice(entities.indexOf(e), 1);
    await DB.del('entities', e.id).catch(() => {});
    refreshUI();
  }
  function countFor(k) {
    const c = { text: 0, voice: 0, video: 0, total: 0 };
    for (const m of msgs.values()) if (m.kairosId === k.id) { c[m.type]++; c.total++; }
    return c;
  }

  /* ---------------- voz posicional por Kairós ---------------- */
  function ensureChain(k) {
    if (k.chain) return k.chain;
    const el = new Audio();
    const src = ctx.createMediaElementSource(el);
    const an = ctx.createAnalyser(); an.fftSize = 128; an.smoothingTimeConstant = 0.75;
    src.connect(an);
    const pa = new THREE.PositionalAudio(listener);
    pa.setNodeSource(an);
    if (pa.panner) { pa.panner.refDistance = 22; pa.panner.rolloffFactor = 1; pa.panner.maxDistance = 4000; }
    k.obj.group.add(pa);
    k.chain = { el, an, pa, data: new Uint8Array(an.frequencyBinCount), msgId: null };
    return k.chain;
  }
  function chainLevel(ch) {
    if (!ch || ch.el.paused) return 0;
    ch.an.getByteFrequencyData(ch.data);
    let s = 0; for (let i = 0; i < ch.data.length; i++) s += ch.data[i];
    return s / ch.data.length / 255;
  }
  async function playVoice(k, msgId, onEnd) {
    wake();
    const ch = ensureChain(k);
    const url = await getURL(msgId);
    if (!url) { toast('No encuentro ese audio'); return; }
    ch.el.onended = null; ch.el.pause();
    ch.el.src = url; ch.msgId = msgId;
    ch.el.onended = () => { ch.msgId = null; hideNow(); if (onEnd) onEnd(); };
    try { await ch.el.play(); } catch (e) { toast('No pude reproducir la voz'); return; }
    const m = msgs.get(msgId);
    showNow(T('●') + '  voz · ' + (m ? new Date(m.createdAt).toLocaleDateString('es-CL') : '') + ' · ' + k.name);
    k.obj.flash();
  }
  function kairosLevel(k) {
    if (rec && rec.ent === k) return rec.recorder.level();
    return k.chain ? chainLevel(k.chain) : 0;
  }

  /* ---------------- reproducción aleatoria (como en Kairós) ---------------- */
  function togglePlayback(k) {
    if (play && play.ent === k) { stopPlayback(); return; }
    stopPlayback();
    play = { ent: k, last: null, timer: null };
    playNext();
    refreshRing();
  }
  function playNext() {
    if (!play) return;
    const k = play.ent;
    const pool = [...msgs.values()].filter(m => m.kairosId === k.id && (m.type === 'voice' || m.type === 'text'));
    if (!pool.length) { toast('Este Kairós todavía no guarda voces ni textos'); stopPlayback(); return; }
    let i = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && pool[i].id === play.last) i = (i + 1) % pool.length;
    const m = pool[i]; play.last = m.id;
    if (m.type === 'voice') {
      playVoice(k, m.id, () => { if (play && play.ent === k) play.timer = setTimeout(playNext, 2000); });
    } else {
      k.obj.highlight(m.id); k.obj.flash();
      showNow('T  ' + (m.text.length > 70 ? m.text.slice(0, 70) + '…' : m.text));
      play.timer = setTimeout(playNext, 5200);
    }
  }
  function stopPlayback() {
    if (!play) return;
    clearTimeout(play.timer);
    const ch = play.ent.chain;
    if (ch) { ch.el.onended = null; ch.el.pause(); ch.msgId = null; }
    play = null; hideNow(); refreshRing();
  }

  /* ---------------- grabación ---------------- */
  async function toggleRecord(k) {
    wake();
    if (rec) {
      const r = rec; rec = null; refreshRing();
      const blob = await r.recorder.stop();
      if (blob) await commitMessage(r.ent, { type: 'voice', blob });
      else toast('No se grabó audio: el navegador cortó el micrófono');
      return;
    }
    const recorder = new L.Recorder(ctx);
    const res = await recorder.start();
    if (!res.ok) { toast(res.msg, 7000); return; }
    rec = { ent: k, recorder };
    toast('Grabando para ' + k.name + ' — tocá ' + T('■') + ' para guardar');
    refreshRing();
  }

  /* ---------------- videos: fotogramas y miniaturas vivas ---------------- */
  const frameQueue = [];
  let frameBusy = false;
  function queueFrames(k, s) { frameQueue.push({ k, s }); }
  function pumpFrames() {
    if (frameBusy || !frameQueue.length) return;
    frameQueue.sort((a, b) => satDist(a.k, a.s) - satDist(b.k, b.s));
    const job = frameQueue.shift();
    if (job.s.dead) return;
    frameBusy = true;
    getBlob(job.s.msgId)
      .then(b => b ? L.extractFrames(b, 8, 256) : null)
      .then(res => {
        if (!res || job.s.dead) return;
        job.s.frames = res.frames; job.s.duration = res.duration;
        job.k.obj.setVideoAspect(job.s, res.aspect);
        if (!job.s.live) job.k.obj.setScreenMap(job.s, res.frames[0]);
      })
      .catch(e => console.warn('[Forja] fotogramas:', e))
      .finally(() => { frameBusy = false; });
  }
  setInterval(pumpFrames, 350);

  const _wp = new V3();
  function satWorld(s) { return s.obj.getWorldPosition(_wp); }
  function satDist(k, s) { return camera.position.distanceTo(satWorld(s)); }

  function activateLive(k, s, withSound) {
    if (s.live) { if (withSound !== undefined) s.live.el.muted = !withSound; return; }
    if (!urlCache.has(s.msgId)) { getURL(s.msgId); return; } // al siguiente pase ya estará
    const el = document.createElement('video');
    el.muted = !withSound; el.loop = true; el.playsInline = true; el.setAttribute('playsinline', '');
    el.src = urlCache.get(s.msgId);
    el.addEventListener('loadedmetadata', () => { if (!s.frames && el.videoWidth) k.obj.setVideoAspect(s, el.videoWidth / el.videoHeight); });
    const tex = new THREE.VideoTexture(el);
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    s.live = { el, tex };
    el.play().catch(() => {});
    k.obj.setScreenMap(s, tex);
  }
  function releaseLive(s, k) {
    if (!s.live) return;
    const { el, tex } = s.live;
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
    tex.dispose();
    s.live = null;
    if (k && !s.dead) k.obj.setScreenMap(s, s.frames ? s.frames[s.fi || 0] : s.screen.material.map);
  }
  function updateVideoLOD(t) {
    const list = [];
    for (const e of entities) {
      if (e.kind !== 'kairos') continue;
      for (const s of e.obj.sats) {
        if (s.type !== 'video') continue;
        if (!e.obj.msgsVisible) { if (s.live && !(zoom && zoom.sat === s)) releaseLive(s, e); continue; }
        list.push({ e, s, d: satDist(e, s) });
      }
    }
    list.sort((a, b) => a.d - b.d);
    let live = 0;
    for (const it of list) {
      const { e, s, d } = it;
      const isZoom = zoom && zoom.sat === s;
      if (isZoom || (live < CFG.maxLiveVideos && d < CFG.liveDist)) {
        if (!isZoom) live++;
        activateLive(e, s);
        continue;
      }
      if (s.live) releaseLive(s, e);
      if (s.frames) {
        const fi = d < CFG.flipDist ? Math.floor(t * CFG.flipFps + s.phase) % s.frames.length : 0;
        if (fi !== s.fi) { s.fi = fi; e.obj.setScreenMap(s, s.frames[fi]); }
      }
    }
  }

  /* =====================================================================
     ÓRBITA (tecla C) — con inercia, heredada de pulsar10
     ===================================================================== */
  function startOrbit(e) {
    if (!e) return;
    if (zoom) unzoom(true);
    releaseHostFocus();
    flight = null;
    const target = e.obj.position;
    const rel = camera.position.clone().sub(target);
    let dist = rel.length();
    const minD = e.radius * 1.15;
    if (dist > e.radius * 6) dist = e.radius * 3.2;
    dist = Math.max(minD, Math.min(CFG.orbitMax, dist));
    orbit = {
      ent: e, dist, minD,
      h: Math.atan2(rel.x, rel.z),
      v: Math.asin(Math.max(-1, Math.min(1, rel.y / (rel.length() || 1)))),
      vh: 0, vv: 0, blend: 0,
      fromPos: camera.position.clone(), fromQuat: camera.quaternion.clone()
    };
    orbit.v = Math.max(-1.35, Math.min(1.35, orbit.v));
    closeRing();
    toast('Orbitando ' + e.name + ' · Shift+C o Esc para salir');
    refreshUI();
  }
  function exitOrbit() {
    if (!orbit) return;
    orbit = null;
    syncHostToCamera();
    refreshUI();
  }
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _up = new V3(0, 1, 0);
  function orbitPose(o) {
    const c = o.ent.obj.position;
    return new V3(
      c.x + o.dist * Math.cos(o.v) * Math.sin(o.h),
      c.y + o.dist * Math.sin(o.v),
      c.z + o.dist * Math.cos(o.v) * Math.cos(o.h)
    );
  }
  function stepOrbit(dt) {
    const o = orbit;
    if (!dragging) {
      o.h += o.vh; o.v += o.vv;
      o.vh *= 0.95; o.vv *= 0.95;
      if (Math.abs(o.vh) < 1e-5) o.vh = 0;
      if (Math.abs(o.vv) < 1e-5) o.vv = 0;
    }
    const sp = 1.2 * dt;
    if (rotateLeft || moveLeft) o.h -= sp;
    if (rotateRight || moveRight) o.h += sp;
    if (moveUp) o.v += sp * 0.7;
    if (moveDown) o.v -= sp * 0.7;
    const zs = Math.max(20, o.dist) * 0.9 * dt;
    if (moveForward) o.dist -= zs;
    if (moveBackward) o.dist += zs;
    o.dist = Math.max(o.minD, Math.min(CFG.orbitMax, o.dist));
    o.v = Math.max(-1.45, Math.min(1.45, o.v));
    const pos = orbitPose(o), target = o.ent.obj.position;
    _m4.lookAt(pos, target, _up); _q.setFromRotationMatrix(_m4);
    if (o.blend < 1) {
      o.blend = Math.min(1, o.blend + dt * 1.25);
      const k = o.blend * o.blend * (3 - 2 * o.blend);
      camera.position.lerpVectors(o.fromPos, pos, k);
      camera.quaternion.copy(o.fromQuat).slerp(_q, k);
    } else {
      camera.position.copy(pos);
      camera.quaternion.copy(_q);
    }
  }
  function nearestOrbitable(preferView) {
    const f = camForward();
    let best = null, bestScore = Infinity;
    for (const e of entities) {
      const rel = e.obj.position.clone().sub(camera.position);
      const d = rel.length();
      const facing = rel.normalize().dot(f);
      const score = preferView ? d * (facing > 0.6 ? 1 : 4) : d;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  /* =====================================================================
     ZOOM a un video o una tarjeta (Enter, click, o tocar de nuevo)
     ===================================================================== */
  function zoomTo(k, s) {
    if (zoom) return;
    releaseHostFocus();
    flight = null;
    closeRing();
    s.frozen = true;
    const pos = satWorld(s).clone();
    const dir = camera.position.clone().sub(pos).normalize();
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const w = s.type === 'text' ? s.obj.scale.x : s.w * s.obj.scale.x;
    const h = s.type === 'text' ? s.obj.scale.y : s.h * s.obj.scale.y;
    const dist = Math.max((h / 2) / tanH, (w / 2) / (tanH * camera.aspect)) * 1.18;
    const toPos = pos.clone().addScaledVector(dir, dist);
    _m4.lookAt(toPos, pos, _up);
    zoom = {
      ent: k, sat: s, phase: 'in', t: 0, prev: orbit ? 'orbit' : 'free',
      fromPos: camera.position.clone(), fromQuat: camera.quaternion.clone(),
      toPos, toQuat: new THREE.Quaternion().setFromRotationMatrix(_m4)
    };
    markOpened(s.msgId);
    if (s.type === 'video') { activateLive(k, s, true); if (s.live) { s.live.el.muted = false; s.live.el.play().catch(() => {}); } }
    showZoomBar();
  }
  function unzoom(instant) {
    if (!zoom) return;
    if (zoom.sat.live) zoom.sat.live.el.muted = true;
    hideZoomBar();
    if (instant) { finishUnzoom(); return; }
    zoom.phase = 'out'; zoom.t = 0;
    zoom.outFrom = camera.position.clone(); zoom.outFromQ = camera.quaternion.clone();
  }
  function finishUnzoom() {
    const z = zoom; zoom = null;
    z.sat.frozen = false;
    if (z.prev === 'free') { camera.position.copy(z.fromPos); camera.quaternion.copy(z.fromQuat); }
  }
  function stepZoom(dt) {
    const z = zoom;
    z.t = Math.min(1, z.t + dt / 0.7);
    const k = z.t < 0.5 ? 2 * z.t * z.t : 1 - Math.pow(-2 * z.t + 2, 2) / 2;
    if (z.phase === 'in') {
      camera.position.lerpVectors(z.fromPos, z.toPos, k);
      camera.quaternion.copy(z.fromQuat).slerp(z.toQuat, k);
      if (z.t >= 1) z.phase = 'hold';
    } else if (z.phase === 'hold') {
      camera.position.copy(z.toPos); camera.quaternion.copy(z.toQuat);
    } else {
      let backPos = z.fromPos, backQ = z.fromQuat;
      if (z.prev === 'orbit' && orbit) {
        backPos = orbitPose(orbit);
        _m4.lookAt(backPos, orbit.ent.obj.position, _up); backQ = new THREE.Quaternion().setFromRotationMatrix(_m4);
      }
      camera.position.lerpVectors(z.outFrom, backPos, k);
      camera.quaternion.copy(z.outFromQ).slerp(backQ, k);
      if (z.t >= 1) finishUnzoom();
    }
  }
  function toggleZoomVideo() {
    if (!zoom || !zoom.sat.live) return;
    const el = zoom.sat.live.el;
    if (el.paused) el.play().catch(() => {}); else el.pause();
    updateZoomBar();
  }
  function nearestZoomable() {
    if (hovered && hovered.type === 'sat' && hovered.sat.type !== 'voice') return hovered;
    let best = null, bd = Infinity;
    for (const e of entities) {
      if (e.kind !== 'kairos' || !e.obj.msgsVisible) continue;
      for (const s of e.obj.sats) {
        if (s.type !== 'video') continue;
        const d = satDist(e, s);
        if (d < bd) { bd = d; best = { type: 'sat', sat: s, ent: e }; }
      }
    }
    return best && bd < CFG.liveDist * 1.6 ? best : null;
  }

  /* =====================================================================
     VUELO ("ir a")
     ===================================================================== */
  function flyTo(e) {
    if (zoom) unzoom(true);
    if (orbit) exitOrbit();
    releaseHostFocus();
    const target = e.obj.position.clone();
    const dir = target.clone().sub(camera.position).normalize();
    yawAngle = Math.atan2(-dir.x, -dir.z);
    pitchAngle = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const end = target.clone().addScaledVector(dir, -e.radius * 1.4);
    flight = { from: avatarObject.position.clone(), to: end, t: 0 };
  }
  function stepFlight(dt) {
    flight.t = Math.min(1, flight.t + dt / 1.4);
    const k = 1 - Math.pow(1 - flight.t, 3);
    avatarObject.position.lerpVectors(flight.from, flight.to, k);
    if (flight.t >= 1 || moveForward || moveBackward || moveLeft || moveRight) flight = null;
  }

  /* =====================================================================
     RAYCAST, HOVER Y TOQUES
     ===================================================================== */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(x, y) {
    ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const cands = [];
    for (const e of entities) {
      if (e.kind === 'kairos' && e.obj.msgsVisible) for (const s of e.obj.sats) cands.push(s.pick);
      cands.push(e.obj.hit);
    }
    const hits = ray.intersectObjects(cands, false);
    if (!hits.length) return null;
    const o = hits[0].object;
    if (o.userData.sat) return { type: 'sat', sat: o.userData.sat, ent: o.userData.ent };
    if (o.userData.ent) return { type: 'ent', ent: o.userData.ent };
    return null;
  }
  window.addEventListener('pointermove', e => { pointerXY = { x: e.clientX, y: e.clientY }; }, { passive: true });
  function updateHover() {
    if (!pointerXY || isTouch) return;
    hovered = pick(pointerXY.x, pointerXY.y);
    const cv = webglRenderer.domElement, cd = cssRenderer.domElement;
    const cur = hovered ? 'pointer' : '';
    if (cv.style.cursor !== cur) { cv.style.cursor = cur; cd.style.cursor = cur; }
  }

  /* =====================================================================
     ARRASTRE
     · textos y videos de un Kairós: mouse o dedo → cambian su órbita
     · Kairós, soles y radios: Shift + arrastrar con el mouse → se mueven
     ===================================================================== */
  let grab = null;
  const _plane = new THREE.Plane(), _hp = new V3(), _tmp = new V3();
  function rayAt(x, y) { ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera); }
  function planeHit(x, y) { rayAt(x, y); return ray.ray.intersectPlane(_plane, _hp) ? _hp : null; }
  function tryGrab(ev) {
    if (zoom || ev.button > 0) return false;
    const h = pick(ev.clientX, ev.clientY);
    if (!h) return false;
    let anchor;
    if (h.type === 'sat' && (h.sat.type === 'text' || h.sat.type === 'video')) anchor = satWorld(h.sat).clone();
    else if (h.type === 'ent' && ev.shiftKey) anchor = h.ent.obj.position.clone();
    else return false;
    _plane.setFromNormalAndCoplanarPoint(camForward(), anchor);
    const p = planeHit(ev.clientX, ev.clientY);
    if (!p) return false;
    grab = { h, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, offset: p.clone().sub(anchor), started: false };
    return true;
  }
  function moveGrab(ev) {
    if (!grab || ev.pointerId !== grab.id) return;
    if (!grab.started) {
      if (Math.hypot(ev.clientX - grab.x0, ev.clientY - grab.y0) <= 8) return;
      grab.started = true;
      if (grab.h.type === 'sat') grab.h.sat.frozen = true;
      document.body.style.cursor = 'grabbing';
      if (ringEnt) closeRing();
    }
    const p = planeHit(ev.clientX, ev.clientY);
    if (!p) return;
    const target = _tmp.copy(p).sub(grab.offset);
    if (grab.h.type === 'sat') {
      const k = grab.h.ent, s = grab.h.sat;
      const lx = target.x - k.obj.position.x, ly = target.y - k.obj.position.y, lz = target.z - k.obj.position.z;
      const a = Math.atan2(lz, lx);
      s.angle = a;
      s.radius = Math.max(6, Math.min(160, Math.hypot(lx, lz)));
      s.height = Math.max(-80, Math.min(80, ly - Math.sin(a * 2.3) * 2));
      k.obj._placeSat(s);
    } else {
      const o = grab.h.ent.obj;
      target.sub(o.position);
      if (o.anchor) o.anchor.add(target); // soles y radios: la deriva lenta sigue, el ancla viaja con la mano
      o.position.add(target);
    }
  }
  function endGrab(ev) {
    if (!grab || (ev && ev.pointerId !== undefined && ev.pointerId !== grab.id)) return;
    const g = grab; grab = null;
    document.body.style.cursor = '';
    if (!g.started) return;
    if (g.h.type === 'sat') {
      const s = g.h.sat; s.frozen = false;
      const m = msgs.get(s.msgId);
      if (m) { m.orbit = { r: s.radius, h: s.height, a: s.angle }; DB.put('messages', m).catch(() => {}); }
    } else {
      persistEnt(g.h.ent);
      toast(g.h.ent.name + ' encontró su nuevo lugar', 1600);
    }
  }
  window.addEventListener('pointerdown', ev => {
    if (ev.target.closest && ev.target.closest(UI_SEL)) return;
    tryGrab(ev);
  }, true);
  window.addEventListener('pointermove', moveGrab, true);
  window.addEventListener('pointerup', endGrab, true);
  window.addEventListener('pointercancel', endGrab, true);
  window.addEventListener('blur', () => endGrab());

  const UI_SEL = '.forja-ui, .hud-btn, .modal, .ui-button, input, textarea, select, button, iframe, video';
  let pDown = null;
  window.addEventListener('pointerdown', e => {
    if (e.target.closest && e.target.closest(UI_SEL)) { pDown = null; return; }
    pDown = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  }, true);
  window.addEventListener('pointerup', e => {
    if (!pDown || e.pointerId !== pDown.id) return;
    const d = Math.hypot(e.clientX - pDown.x, e.clientY - pDown.y), dt = performance.now() - pDown.t;
    pDown = null;
    if (d > 8 || dt > 550) return;
    shiftTap = e.shiftKey;
    onTap(e.clientX, e.clientY);
  }, true);

  let shiftTap = false;
  function onTap(x, y) {
    if (zoom) {
      if (zoom.phase !== 'hold') return;
      const h = pick(x, y);
      if (h && h.type === 'sat' && h.sat === zoom.sat) { if (zoom.sat.type === 'video') toggleZoomVideo(); else unzoom(); }
      else unzoom();
      return;
    }
    const h = pick(x, y);
    if (!h) { if (ringEnt) closeRing(); return; }
    if (h.type === 'sat') {
      const s = h.sat;
      if (s.type === 'voice') { markOpened(s.msgId); playVoice(h.ent, s.msgId); }
      else zoomTo(h.ent, s);
      return;
    }
    if (h.ent.kind === 'kairos') { if (!shiftTap) toggleRing(h.ent); }
    else if (!shiftTap) toggleSun(h.ent);
  }

  /* ---------------- gestos táctiles: mirar, pellizcar ---------------- */
  const touches = new Map();
  let pinchD = null, dragging = false;
  window.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    if (e.target.closest && e.target.closest(UI_SEL)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = true;
    if (touches.size === 2) { const [a, b] = [...touches.values()]; pinchD = Math.hypot(a.x - b.x, a.y - b.y); }
  }, { passive: true });
  window.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    const prev = touches.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
    touches.set(e.pointerId, cur);
    if (touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD != null) wheelLike((pinchD - d) * 2.5);
      pinchD = d; return;
    }
    const dx = cur.x - prev.x, dy = cur.y - prev.y;
    if (zoom || grab) return;
    if (orbit) { orbitDrag(dx, dy, 0.006); return; }
    if (isFocused) return;
    yawAngle -= dx * 0.004; pitchAngle -= dy * 0.004;
    pitchAngle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitchAngle));
  }, { passive: true });
  const endTouch = e => {
    if (e.pointerType !== 'touch') return;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchD = null;
    if (!touches.size) dragging = false;
  };
  window.addEventListener('pointerup', endTouch, { passive: true });
  window.addEventListener('pointercancel', endTouch, { passive: true });
  window.addEventListener('mousedown', () => { dragging = true; });
  window.addEventListener('mouseup', () => { dragging = false; });

  function orbitDrag(dx, dy, sens) {
    orbit.h -= dx * sens; orbit.v += dy * sens;
    orbit.vh = -dx * sens * 0.5; orbit.vv = dy * sens * 0.5;
  }
  function wheelLike(dy) {
    if (orbit && !zoom) { orbit.dist = Math.max(orbit.minD, Math.min(CFG.orbitMax, orbit.dist + dy * 0.08 * Math.max(1, orbit.dist / 60))); return true; }
    if (zoom) return true;
    if (!isFocused && !isTransitioning) { zoomDistance = Math.max(5, Math.min(100, zoomDistance + dy * 0.02)); }
    return false;
  }

  /* =====================================================================
     LLEGADAS (los rebotes de Kairós)
     ===================================================================== */
  const SCHED = [
    ['', 'sin regreso'], ['120000', 'eco · 2 min'], ['604800000', 'en 1 semana'],
    ['2592000000', 'en 1 mes'], ['15724800000', 'en 6 meses'], ['31536000000', 'en 1 año'], ['custom', 'fecha propia…']
  ];
  async function scheduleMsg(id, ts) {
    const m = msgs.get(id); if (!m) return;
    m.bounces = ts ? [{ ts, arrived: false, opened: false }] : [];
    await DB.put('messages', m);
    const k = entities.find(e => e.id === m.kairosId);
    if (k) { k.obj.markArrived(id, false); if (ts) k.obj.flash(); }
    if (ts) toast('Volverá ' + etaText(ts));
    refreshUI();
  }
  function etaText(ts) {
    const diff = ts - Date.now();
    if (diff <= 0) return 'ya llegó';
    const s = Math.floor(diff / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return 'en ' + d + ' día' + (d > 1 ? 's' : '');
    if (h >= 1) return 'en ' + h + 'h ' + (m % 60) + 'm';
    if (m >= 1) return 'en ' + m + 'm';
    return 'en ' + s + 's';
  }
  async function checkArrivals() {
    let any = false;
    for (const m of msgs.values()) {
      let ch = false;
      for (const b of (m.bounces || [])) if (!b.arrived && b.ts <= Date.now()) { b.arrived = true; ch = true; }
      if (ch) {
        any = true;
        await DB.put('messages', m);
        const k = entities.find(e => e.id === m.kairosId);
        if (k) { k.obj.markArrived(m.id, true); k.obj.flash(); }
      }
    }
    if (any) {
      toast('Un mensaje de tu pasado llegó a la orilla ' + T('✦'), 5000);
      if (prefs.notif && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Kairós', { body: 'Un mensaje de tu pasado llegó a la orilla.' }); } catch (e) {}
      }
      refreshUI();
    }
  }
  async function markOpened(id) {
    const m = msgs.get(id); if (!m) return;
    const b = (m.bounces || []).find(x => x.arrived && !x.opened);
    if (!b) return;
    b.opened = true;
    await DB.put('messages', m);
    const k = entities.find(e => e.id === m.kairosId);
    if (k) k.obj.markArrived(id, false);
    refreshUI();
  }
  function openArrived(id) {
    const m = msgs.get(id); if (!m) return;
    const k = entities.find(e => e.id === m.kairosId); if (!k) return;
    if (!k.obj.msgsVisible) k.obj.setMessagesVisible(true);
    const s = k.obj.sats.find(x => x.msgId === id);
    if (m.type === 'voice') { markOpened(id); flyTo(k); playVoice(k, id); return; }
    if (s) {
      if (camera.position.distanceTo(k.obj.position) > 90) { flyTo(k); setTimeout(() => zoomTo(k, s), 1500); }
      else zoomTo(k, s);
    }
  }
  setInterval(checkArrivals, 15000);

  /* =====================================================================
     INTERFAZ
     ===================================================================== */
  const fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap';
  document.head.appendChild(fontLink);

  const css = `
  :root{--fx-glass:rgba(4,9,20,.74);--fx-line:rgba(77,219,255,.22);--fx-line2:rgba(77,219,255,.45);
    --fx-text:#e6f6ff;--fx-dim:rgba(220,240,255,.55);--fx-k:${COLORS.kairos};--fx-s:${COLORS.sun};--fx-r:${COLORS.tagua};--fx-b:#4DDBFF;}
  #webgl-container,#css-container{touch-action:none;}
  .forja-ui{font-family:'Lato',sans-serif;color:var(--fx-text);-webkit-user-select:none;user-select:none;}
  .forja-ui input,.forja-ui textarea,.forja-ui select{-webkit-user-select:text;user-select:text;}
  .fx-mono{font-family:'Share Tech Mono',monospace;}
  #fx-open{top:104px;right:30px;font-size:26px;background:radial-gradient(circle at 35% 30%,#bffcff,var(--fx-k) 45%,#0a6d78);
    box-shadow:0 0 22px rgba(0,232,200,.7);color:#02121a;font-family:'Cinzel',serif;}
  #fx-open:hover{transform:scale(1.1) rotate(36deg);}
  #fx-drawer{position:fixed;top:16px;right:16px;bottom:16px;width:min(380px,calc(100vw - 32px));z-index:250;
    background:var(--fx-glass);backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);
    border:1px solid var(--fx-line);border-radius:16px;box-shadow:0 0 40px rgba(0,119,255,.25),inset 0 0 30px rgba(77,219,255,.04);
    display:flex;flex-direction:column;transform:translateX(calc(100% + 30px));opacity:0;transition:transform .35s cubic-bezier(.2,.8,.3,1),opacity .25s;}
  #fx-drawer.open{transform:none;opacity:1;}
  .fx-head{display:flex;justify-content:space-between;align-items:flex-start;padding:18px 18px 10px;}
  .fx-brand{font-family:'Cinzel',serif;letter-spacing:5px;font-size:15px;color:var(--fx-b);text-shadow:0 0 12px rgba(77,219,255,.6);}
  .fx-brand span{display:block;font-family:'Share Tech Mono',monospace;letter-spacing:2px;font-size:9.5px;color:var(--fx-dim);margin-top:4px;text-shadow:none;}
  .fx-x{background:none;border:1px solid var(--fx-line);color:var(--fx-dim);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:16px;}
  .fx-x:hover{color:#fff;border-color:var(--fx-line2);}
  .fx-tabs{display:flex;gap:4px;padding:0 14px;border-bottom:1px solid var(--fx-line);}
  .fx-tabs button{flex:1;background:none;border:none;border-bottom:2px solid transparent;color:var(--fx-dim);padding:10px 2px 9px;
    font-family:'Cinzel',serif;font-size:11px;letter-spacing:1.5px;cursor:pointer;transition:color .2s,border-color .2s;}
  .fx-tabs button.on{color:#fff;}
  .fx-tabs button[data-tab=kairos].on{border-color:var(--fx-k);} .fx-tabs button[data-tab=soles].on{border-color:var(--fx-s);}
  .fx-tabs button[data-tab=radio].on{border-color:var(--fx-r);} .fx-tabs button[data-tab=mapa].on{border-color:var(--fx-b);}
  .fx-body{flex:1;overflow-y:auto;padding:14px 14px 22px;touch-action:pan-y;}
  .fx-body::-webkit-scrollbar{width:6px;} .fx-body::-webkit-scrollbar-thumb{background:rgba(77,219,255,.35);border-radius:4px;}
  .fx-card{border:1px solid var(--fx-line);border-radius:12px;padding:14px;margin-bottom:12px;background:rgba(255,255,255,.02);}
  .fx-card.acc-k{border-color:rgba(0,232,200,.4);box-shadow:inset 0 0 24px rgba(0,232,200,.06);}
  .fx-card.acc-s{border-color:rgba(255,211,77,.4);box-shadow:inset 0 0 24px rgba(255,211,77,.05);}
  .fx-card.acc-r{border-color:rgba(255,111,168,.45);box-shadow:inset 0 0 24px rgba(255,111,168,.06);}
  .fx-card h4{margin:0 0 8px;font-family:'Cinzel',serif;font-weight:400;font-size:12.5px;letter-spacing:2.5px;text-transform:uppercase;color:#fff;}
  .fx-card h4 .n{font-family:'Share Tech Mono',monospace;font-size:10px;color:var(--fx-dim);letter-spacing:1px;margin-left:6px;}
  .fx-note{font-size:12.5px;line-height:1.55;color:var(--fx-dim);margin:0 0 12px;}
  .fx-in{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid var(--fx-line);color:var(--fx-text);
    border-radius:8px;padding:9px 10px;font-size:13px;outline:none;font-family:'Lato',sans-serif;}
  .fx-in:focus{border-color:var(--fx-line2);}
  .fx-sw{display:flex;gap:10px;margin:12px 0;align-items:center;}
  .fx-sw button{width:28px;height:28px;border-radius:50%;cursor:pointer;border:2px solid transparent;padding:0;}
  .fx-sw button.on{border-color:#fff;box-shadow:0 0 12px currentColor;}
  .fx-sw span{font-size:11px;color:var(--fx-dim);margin-left:4px;}
  .fx-btn{background:rgba(77,219,255,.08);border:1px solid var(--fx-line2);color:var(--fx-text);border-radius:8px;padding:8px 12px;
    font-size:12px;letter-spacing:.5px;cursor:pointer;transition:background .2s,border-color .2s;font-family:'Lato',sans-serif;}
  .fx-btn:hover{background:rgba(77,219,255,.18);}
  .fx-btn.wide{width:100%;padding:11px;font-family:'Cinzel',serif;letter-spacing:2.5px;font-size:12px;}
  .fx-btn.k{border-color:rgba(0,232,200,.6);background:rgba(0,232,200,.12);} .fx-btn.k:hover{background:rgba(0,232,200,.24);}
  .fx-btn.s{border-color:rgba(255,211,77,.6);background:rgba(255,211,77,.10);} .fx-btn.s:hover{background:rgba(255,211,77,.22);}
  .fx-btn.r{border-color:rgba(255,111,168,.6);background:rgba(255,111,168,.10);} .fx-btn.r:hover{background:rgba(255,111,168,.22);}
  .fx-btn.ghost{background:none;border-color:var(--fx-line);color:var(--fx-dim);}
  .fx-btn.danger:hover{border-color:#ff7a8a;color:#ff9aa6;background:rgba(255,80,100,.1);}
  .fx-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid rgba(77,219,255,.1);}
  .fx-item:first-of-type{border-top:none;}
  .fx-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;box-shadow:0 0 10px currentColor;background:currentColor;}
  .fx-main{flex:1;min-width:0;}
  .fx-title{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .fx-meta{font-family:'Share Tech Mono',monospace;font-size:10.5px;color:var(--fx-dim);margin-top:2px;}
  .fx-acts{display:flex;gap:4px;flex-shrink:0;}
  .fx-ico{width:30px;height:30px;border-radius:50%;border:1px solid var(--fx-line);background:rgba(255,255,255,.03);color:var(--fx-text);
    cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;padding:0;font-family:'Share Tech Mono',monospace;}
  .fx-ico:hover{border-color:var(--fx-line2);background:rgba(77,219,255,.12);}
  .fx-ico.on{border-color:var(--fx-k);color:var(--fx-k);}
  .fx-ico.danger:hover{border-color:#ff7a8a;color:#ff9aa6;}
  .fx-msgs{margin:4px 0 6px 20px;border-left:1px solid var(--fx-line);padding-left:10px;}
  .fx-msg{display:flex;gap:8px;align-items:center;padding:7px 0;border-top:1px dashed rgba(77,219,255,.1);}
  .fx-msg:first-child{border-top:none;}
  .fx-glyph{width:20px;text-align:center;color:var(--fx-k);font-family:'Share Tech Mono',monospace;}
  .fx-msg select,.fx-msg input{background:rgba(255,255,255,.05);border:1px solid var(--fx-line);color:var(--fx-text);border-radius:6px;
    font-size:10.5px;padding:4px;max-width:96px;font-family:'Share Tech Mono',monospace;}
  .fx-msg select option{background:#081320;}
  .fx-empty{font-size:12px;color:var(--fx-dim);text-align:center;padding:12px 4px;line-height:1.6;}
  .fx-file{display:block;text-align:center;padding:16px;border:1px dashed rgba(255,211,77,.55);border-radius:10px;cursor:pointer;font-size:12.5px;
    color:#ffe9a6;letter-spacing:.5px;}
  .fx-file:hover{background:rgba(255,211,77,.07);} .fx-file input{display:none;}
  .fx-slider{display:flex;align-items:center;gap:10px;margin:10px 0;font-size:12px;color:var(--fx-dim);}
  .fx-slider label{width:92px;flex-shrink:0;} .fx-slider input{flex:1;accent-color:var(--fx-b);} .fx-slider .v{width:34px;text-align:right;font-family:'Share Tech Mono',monospace;font-size:11px;}
  .fx-toggle{display:flex;align-items:center;justify-content:space-between;padding:8px 0;font-size:13px;}
  .fx-toggle input{accent-color:var(--fx-k);width:18px;height:18px;}
  .fx-keys{font-family:'Share Tech Mono',monospace;font-size:11px;line-height:1.9;color:var(--fx-dim);}
  .fx-keys b{color:#fff;font-weight:400;border:1px solid var(--fx-line);border-radius:4px;padding:0 5px;margin-right:6px;}
  .fx-status{font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1px;padding:8px 10px;border-radius:8px;background:rgba(255,111,168,.08);
    color:#ffc0d8;margin-bottom:12px;display:flex;align-items:center;gap:8px;}
  .fx-status i{width:8px;height:8px;border-radius:50%;background:#555;display:inline-block;}
  .fx-status.live i{background:var(--fx-r);box-shadow:0 0 10px var(--fx-r);animation:fxPulse 1.4s infinite;}
  .fx-row{display:flex;gap:8px;flex-wrap:wrap;}
  @keyframes fxPulse{0%,100%{opacity:1}50%{opacity:.35}}

  /* anillo de acciones del Kairós */
  #fx-ring{position:fixed;z-index:180;transform:translate(-50%,0);display:none;flex-direction:column;align-items:center;gap:8px;pointer-events:none;}
  #fx-ring.show{display:flex;}
  #fx-ring .nm{font-family:'Cinzel',serif;letter-spacing:3px;font-size:12px;color:#fff;text-shadow:0 0 10px var(--fx-k);}
  #fx-ring .row{display:flex;gap:8px;pointer-events:auto;padding:6px;border-radius:40px;background:rgba(2,10,16,.55);
    border:1px solid rgba(0,232,200,.3);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}
  #fx-ring button{width:42px;height:42px;border-radius:50%;border:1px solid rgba(0,232,200,.65);background:rgba(0,232,200,.08);
    color:#bffff4;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:'Share Tech Mono',monospace;padding:0;
    transition:background .2s,transform .15s;}
  #fx-ring button:hover{background:rgba(0,232,200,.22);transform:scale(1.08);}
  #fx-ring button.rec{border-color:#ff4d5e;color:#ff6b7a;background:rgba(255,77,94,.08);}
  #fx-ring button.rec.on{background:rgba(255,77,94,.25);animation:fxPulse 1s infinite;}
  #fx-ring button.on{background:rgba(0,232,200,.28);}
  #fx-ring .tip{font-family:'Share Tech Mono',monospace;font-size:10px;color:var(--fx-dim);letter-spacing:1px;min-height:12px;}

  /* barra de zoom */
  #fx-zoombar{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);z-index:190;display:flex;align-items:center;gap:10px;
    padding:8px 12px;border-radius:30px;background:rgba(2,8,16,.72);border:1px solid var(--fx-line2);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;max-width:calc(100vw - 32px);}
  #fx-zoombar.show{opacity:1;pointer-events:auto;transform:translateX(-50%);}
  #fx-zoombar .lbl{font-family:'Share Tech Mono',monospace;font-size:11px;color:var(--fx-dim);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #fx-zoombar input[type=range]{width:min(260px,40vw);accent-color:var(--fx-k);}

  /* toast y "sonando ahora" */
  #fx-toast{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:260;padding:9px 18px;border-radius:22px;font-size:12.5px;
    background:rgba(0,40,48,.7);border:1px solid rgba(0,232,200,.5);color:#d8fff7;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
    opacity:0;transition:opacity .35s;pointer-events:none;max-width:calc(100vw - 40px);text-align:center;}
  #fx-toast.show{opacity:1;}
  #fx-now{position:fixed;left:50%;bottom:128px;transform:translateX(-50%);z-index:170;font-family:'Share Tech Mono',monospace;font-size:11.5px;
    color:#c8b6ff;letter-spacing:1px;padding:6px 14px;border-radius:16px;background:rgba(20,10,40,.55);border:1px solid rgba(155,107,255,.4);
    opacity:0;transition:opacity .3s;pointer-events:none;max-width:calc(100vw - 40px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  #fx-now.show{opacity:1;}

  /* radar */
  #fx-radar{position:fixed;top:44px;left:16px;z-index:120;display:flex;flex-direction:column;align-items:center;gap:6px;}
  #fx-radar canvas{border-radius:50%;cursor:pointer;display:block;}
  #fx-radar .leg{display:flex;gap:9px;font-family:'Share Tech Mono',monospace;font-size:9.5px;letter-spacing:.5px;color:var(--fx-dim);}
  #fx-radar .leg i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle;}
  #fx-radar .mini{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:1px solid var(--fx-line2);
    background:rgba(2,8,16,.85);color:var(--fx-dim);font-size:11px;cursor:pointer;padding:0;line-height:18px;}
  #fx-radar.small .leg{display:none;}

  /* modal de texto */
  #fx-modal{position:fixed;inset:0;z-index:300;display:none;align-items:center;justify-content:center;background:rgba(0,4,8,.35);padding:18px;}
  #fx-modal.show{display:flex;}
  #fx-modal .box{width:min(460px,100%);background:var(--fx-glass);border:1px solid rgba(0,232,200,.55);border-radius:16px;padding:22px;
    backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 0 50px rgba(0,232,200,.2);}
  #fx-modal h3{margin:0 0 14px;font-family:'Cinzel',serif;font-weight:400;letter-spacing:3px;font-size:13px;color:var(--fx-k);}
  #fx-modal textarea{min-height:130px;resize:vertical;font-family:'Share Tech Mono',monospace;}

  /* controles táctiles */
  #fx-joy{position:fixed;left:22px;bottom:22px;width:116px;height:116px;border-radius:50%;z-index:150;
    background:radial-gradient(circle,rgba(77,219,255,.08),rgba(77,219,255,.02));border:1px solid var(--fx-line2);display:none;touch-action:none;}
  #fx-joy i{position:absolute;left:50%;top:50%;width:50px;height:50px;margin:-25px 0 0 -25px;border-radius:50%;
    background:radial-gradient(circle at 35% 30%,rgba(191,252,255,.8),rgba(77,219,255,.35));box-shadow:0 0 14px rgba(77,219,255,.6);}
  #fx-tbtns{position:fixed;right:20px;bottom:24px;z-index:150;display:none;flex-direction:column;gap:12px;}
  #fx-tbtns button{width:52px;height:52px;border-radius:50%;border:1px solid var(--fx-line2);background:rgba(2,10,18,.55);color:#cdefff;
    font-size:17px;touch-action:none;font-family:'Share Tech Mono',monospace;}
  body.fx-touch #fx-joy{display:block;} body.fx-touch #fx-tbtns{display:flex;}
  body.fx-touch #instructions{display:none;}
  body.fx-zooming #fx-joy, body.fx-zooming #fx-tbtns{opacity:.25;}

  /* armonización con el modal de creación de Mundo Interior */
  #creation-modal .modal-content{background:var(--fx-glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
    border-color:var(--fx-line2);border-radius:16px;}
  #creation-modal .modal-content input,#creation-modal .modal-content textarea,#creation-modal .modal-content select{border-color:var(--fx-line);border-radius:8px;}
  #creation-modal .io-buttons button{font-family:'Share Tech Mono',monospace;font-size:15px;}
  @media (max-width:600px){ #fx-radar{top:40px;left:10px;} .fx-tabs button{font-size:10px;letter-spacing:1px;} }
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  if (isTouch) document.body.classList.add('fx-touch');

  const root = document.createElement('div');
  root.className = 'forja-ui hud-btn';
  root.innerHTML = `
    <button id="fx-open" class="ui-button forja-ui hud-btn" title="Forja estelar">${T('✦')}</button>
    <aside id="fx-drawer" class="forja-ui hud-btn">
      <div class="fx-head"><div class="fx-brand">FORJA ESTELAR<span>mundo interior · chamalnquimyst labs</span></div>
        <button class="fx-x" id="fx-close" title="cerrar">×</button></div>
      <nav class="fx-tabs">
        <button data-tab="kairos" class="on">Kairós</button><button data-tab="soles">Soles</button>
        <button data-tab="radio">Radio</button><button data-tab="mapa">Mapa</button>
      </nav>
      <section class="fx-body" id="fx-body"></section>
    </aside>
    <div id="fx-ring" class="forja-ui hud-btn">
      <div class="nm"></div>
      <div class="row">
        <button data-r="rec" class="rec" title="grabar voz">${T('●')}</button>
        <button data-r="text" title="dejar un texto">T</button>
        <button data-r="video" title="subir video">${T('▣')}</button>
        <button data-r="play" title="reproducir sus voces y textos">${T('▶')}</button>
        <button data-r="msgs" title="mostrar u ocultar mensajes">${T('◇')}</button>
        <button data-r="orbit" title="orbitar (C)">${T('◎')}</button>
        <button data-r="close" title="cerrar">×</button>
      </div>
      <div class="tip"></div>
    </div>
    <div id="fx-zoombar" class="forja-ui hud-btn">
      <button class="fx-ico" data-z="play">${T('❚❚')}</button>
      <input type="range" min="0" max="1000" value="0" data-z="seek">
      <button class="fx-ico" data-z="sound" title="sonido">♪</button>
      <span class="lbl"></span>
      <button class="fx-ico" data-z="close" title="salir (Esc)">×</button>
    </div>
    <div id="fx-toast"></div>
    <div id="fx-now"></div>
    <div id="fx-radar" class="forja-ui hud-btn">
      <canvas id="fx-radar-cv"></canvas>
      <button class="mini" title="minimizar">–</button>
      <div class="leg"><span><i style="background:${COLORS.kairos}"></i>kairós</span><span><i style="background:${COLORS.sun}"></i>soles</span><span><i style="background:${COLORS.tagua}"></i>tagua</span></div>
    </div>
    <div id="fx-modal" class="forja-ui hud-btn"><div class="box">
      <h3 id="fx-modal-title">MENSAJE AL FUTURO</h3>
      <textarea id="fx-text" class="fx-in" placeholder="Escribile a quien vas a ser..."></textarea>
      <div class="fx-row" style="margin-top:12px;justify-content:flex-end;">
        <button class="fx-btn ghost" data-m="cancel">cancelar</button>
        <button class="fx-btn k" data-m="ok">suspender en el plasma</button>
      </div></div></div>
    <div id="fx-joy" class="forja-ui hud-btn"><i></i></div>
    <div id="fx-tbtns" class="forja-ui hud-btn">
      <button data-t="up">${T('▲')}</button><button data-t="down">${T('▼')}</button><button data-t="orbit">${T('◎')}</button>
    </div>
    <input type="file" id="fx-video-in" accept="video/*" multiple style="display:none">
  `;
  document.body.appendChild(root);
  const $ = id => document.getElementById(id);
  const drawer = $('fx-drawer'), body = $('fx-body'), ring = $('fx-ring'), zbar = $('fx-zoombar');

  // símbolos en lugar de emoji en los botones de Mundo Interior
  const io = { 'save-scene-btn': '⤓', 'load-scene-btn': '⤒', 'scan-folder-btn': '⌕' };
  Object.keys(io).forEach(id => { const b = $(id); if (b) b.textContent = io[id]; });
  const ins = $('instructions');
  if (ins) ins.innerHTML = '[W,A,S,D] moverse · [Z,X] subir/bajar · [Q,E] y ratón girar · [Doble click] enfocar panel · ' +
    '[✦] Forja estelar · [C] orbitar estrella · [Shift+C] salir · [Enter] zoom al video · [Esc] volver';

  /* ---------------- toast / ahora ---------------- */
  let toastT = null, nowT = null;
  function toast(msg, ms) {
    const t = $('fx-toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 3200);
  }
  function showNow(msg) { const n = $('fx-now'); n.textContent = msg; n.classList.add('show'); clearTimeout(nowT); }
  function hideNow() { clearTimeout(nowT); nowT = setTimeout(() => $('fx-now').classList.remove('show'), 600); }

  /* ---------------- cajón ---------------- */
  let tab = 'kairos', newHue = 'calipso', expanded = new Set(), customFor = null;
  const openBtn = $('fx-open');
  openBtn.addEventListener('click', () => { drawer.classList.toggle('open'); refreshUI(); });
  $('fx-close').addEventListener('click', () => drawer.classList.remove('open'));
  drawer.querySelectorAll('.fx-tabs button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    drawer.querySelectorAll('.fx-tabs button').forEach(x => x.classList.toggle('on', x === b));
    refreshUI();
  }));
  let idleT = null;
  function unfade() { openBtn.classList.remove('faded'); clearTimeout(idleT); idleT = setTimeout(() => openBtn.classList.add('faded'), 5000); }
  document.addEventListener('mousemove', unfade); document.addEventListener('touchstart', unfade, { passive: true }); unfade();

  let uiDirty = false;
  function refreshUI() { uiDirty = true; }
  function renderUI() {
    if (!drawer.classList.contains('open')) { uiDirty = false; return; }
    const ae = document.activeElement;
    if (ae && body.contains(ae)) {
      // no destruir un campo mientras se escribe en él (Mundo Interior bloquearía el teclado)
      if (ae.tagName === 'TEXTAREA' || ae.type === 'text' || ae.type === 'datetime-local') return;
      ae.blur();
    }
    uiDirty = false;
    const keepScroll = body.scrollTop;
    if (tab === 'kairos') body.innerHTML = viewKairos();
    else if (tab === 'soles') body.innerHTML = viewSoles();
    else if (tab === 'radio') body.innerHTML = viewRadio();
    else body.innerHTML = viewMapa();
    body.scrollTop = keepScroll;
  }

  function updateDistances() {
    body.querySelectorAll('[data-fade]').forEach(el => {
      const e = entities.find(x => x.id === el.dataset.fade);
      el.textContent = e && e.obj.playing && e.fade != null ? ' · ' + Math.round(e.fade * 100) + '%' : '';
    });
    body.querySelectorAll('[data-dist]').forEach(el => {
      const e = entities.find(x => x.id === el.dataset.dist);
      if (e) el.textContent = Math.round(camera.position.distanceTo(e.obj.position));
    });
  }
  function entButtons(e) {
    const orbiting = orbit && orbit.ent === e;
    return `<button class="fx-ico" data-a="go" data-id="${e.id}" title="ir">${T('↗')}</button>
      <button class="fx-ico ${orbiting ? 'on' : ''}" data-a="orbit" data-id="${e.id}" title="orbitar">${T('◎')}</button>`;
  }
  function viewKairos() {
    const ks = entities.filter(e => e.kind === 'kairos');
    const arrived = [...msgs.values()].filter(m => (m.bounces || []).some(b => b.arrived && !b.opened));
    const notifOn = prefs.notif && 'Notification' in window && Notification.permission === 'granted';
    const sw = Object.keys(HUES).map(h => `<button data-a="hue" data-hue="${h}" class="${h === newHue ? 'on' : ''}" style="background:${HUES[h].a};color:${HUES[h].a}" title="${HUES[h].label}"></button>`).join('');
    let html = `<div class="fx-card acc-k"><h4>Encender un Kairós</h4>
      <p class="fx-note">Una estrella de plasma que guarda tu voz, tus palabras y tus imágenes, orbitando para quien vas a ser. Shift + arrastrar lo mueve por el espacio.</p>
      <input class="fx-in" id="fx-kname" placeholder="nombre (opcional)" maxlength="40">
      <div class="fx-sw">${sw}<span>${HUES[newHue].label}</span></div>
      <button class="fx-btn k wide" data-a="k-create">Encender frente a mí</button></div>`;
    html += `<div class="fx-card"><h4>Llegados<span class="n">${arrived.length}</span></h4>`;
    html += arrived.length ? arrived.map(m => {
      const k = entities.find(e => e.id === m.kairosId);
      return `<div class="fx-item"><span class="fx-glyph">${glyph(m)}</span><div class="fx-main"><div class="fx-title">${esc(preview(m))}</div>
        <div class="fx-meta">escrito el ${new Date(m.createdAt).toLocaleDateString('es-CL')} · ${esc(k ? k.name : '')}</div></div>
        <button class="fx-btn k" data-a="m-open" data-id="${m.id}">abrir</button></div>`;
    }).join('') : `<div class="fx-empty">Cuando un mensaje vuelva a vos, aparece acá.</div>`;
    html += `</div><div class="fx-card"><h4>Tus Kairós<span class="n">${ks.length}</span></h4>`;
    if (!ks.length) html += `<div class="fx-empty">Todavía no encendiste ninguno.<br>Tocá la estrella después de crearla para grabar, escribir o subir videos.</div>`;
    ks.forEach(k => {
      const c = countFor(k), open = expanded.has(k.id);
      const d = Math.round(camera.position.distanceTo(k.obj.position));
      html += `<div class="fx-item"><span class="fx-dot" style="color:${HUES[k.hue] ? HUES[k.hue].a : COLORS.kairos}"></span>
        <div class="fx-main"><div class="fx-title">${esc(k.name)}</div><div class="fx-meta">${c.text} textos · ${c.voice} voces · ${c.video} videos · <span data-dist="${k.id}">${d}</span> u</div></div>
        <div class="fx-acts">${entButtons(k)}<button class="fx-ico" data-a="ring" data-id="${k.id}" title="acciones">${T('✦')}</button>
        <button class="fx-ico ${open ? 'on' : ''}" data-a="expand" data-id="${k.id}" title="mensajes">≡</button>
        <button class="fx-ico danger" data-a="del" data-id="${k.id}" title="apagar">×</button></div></div>`;
      if (open) {
        const list = [...msgs.values()].filter(m => m.kairosId === k.id).sort((a, b) => b.createdAt - a.createdAt);
        html += `<div class="fx-msgs">` + (list.length ? list.map(m => msgRow(m)).join('') : `<div class="fx-empty">Sin mensajes todavía.</div>`) + `</div>`;
      }
    });
    html += `</div><div class="fx-row"><button class="fx-btn ghost" data-a="notif">${notifOn ? T('◉') + ' avisos activos' : T('○') + ' activar avisos de llegada'}</button></div>`;
    return html;
  }
  function glyph(m) { return m.type === 'voice' ? T('●') : m.type === 'video' ? T('▣') : 'T'; }
  function preview(m) {
    if (m.type === 'text') return m.text.length > 64 ? m.text.slice(0, 64) + '…' : m.text;
    if (m.type === 'voice') return 'mensaje de voz';
    return m.name || 'video';
  }
  function msgRow(m) {
    const b = (m.bounces || [])[0];
    const state = !b ? '' : b.arrived ? (b.opened ? ' · volvió' : ' · llegó') : ' · vuelve ' + etaText(b.ts);
    let sel = `<select data-a="sched" data-id="${m.id}">` + SCHED.map(([v, l]) => `<option value="${v}" ${(!b && v === '') ? 'selected' : ''}>${l}</option>`).join('');
    if (b) sel += `<option value="keep" selected>${b.arrived ? 'regresado' : 'programado'}</option>`;
    sel += `</select>`;
    const custom = customFor === m.id ? `<input type="datetime-local" data-a="sched-date" data-id="${m.id}">` : '';
    return `<div class="fx-msg"><span class="fx-glyph">${glyph(m)}</span><div class="fx-main"><div class="fx-title" style="font-size:12px">${esc(preview(m))}</div>
      <div class="fx-meta">${new Date(m.createdAt).toLocaleDateString('es-CL')}${state}</div></div>
      ${sel}${custom}<button class="fx-ico" data-a="m-open" data-id="${m.id}" title="ver">${T('◉')}</button>
      <button class="fx-ico danger" data-a="m-del" data-id="${m.id}" title="borrar">×</button></div>`;
  }
  function soundRow(e, color) {
    const live = e.obj.playing, out = e.armed && !e.inside;
    const fade = e.fade != null && live ? ' · ' + Math.round(e.fade * 100) + '%' : '';
    return `<div class="fx-item"><span class="fx-dot" style="color:${color};opacity:${out ? .45 : 1}"></span><div class="fx-main"><div class="fx-title">${esc(e.name)}</div>
      <div class="fx-meta">${esc(e.status)}<span data-fade="${e.id}">${fade}</span> · <span data-dist="${e.id}">${Math.round(camera.position.distanceTo(e.obj.position))}</span> u</div></div>
      <div class="fx-acts"><button class="fx-ico ${e.armed ? 'on' : ''}" data-a="s-play" data-id="${e.id}" title="${e.armed ? 'apagar' : 'encender'}">${T(e.armed ? '❚❚' : '▶')}</button>
      ${entButtons(e)}${e.kind === 'tagua' ? `<button class="fx-ico" data-a="bring" data-id="${e.id}" title="traer frente a mí">${T('⊕')}</button>` : ''}
      <button class="fx-ico danger" data-a="del" data-id="${e.id}" title="apagar para siempre">×</button></div></div>`;
  }
  function viewSoles() {
    const ss = entities.filter(e => e.kind === 'sun');
    let html = `<div class="fx-card acc-s"><h4>Encender soles de audio</h4>
      <p class="fx-note">Cada archivo se vuelve una nebulosa que canta desde su lugar en el espacio. Más fuerte cerca de su núcleo; fuera de su influjo deja de sonar y retoma cuando volvés.</p>
      <label class="fx-file">${T('✦')} elegir audio(s)<input type="file" accept="audio/*" multiple data-a="s-file"></label></div>
      <div class="fx-card"><h4>Soles<span class="n">${ss.length}</span></h4>`;
    html += ss.length ? ss.map(e => soundRow(e, COLORS.sun)).join('') : `<div class="fx-empty">Ningún sol todavía.</div>`;
    html += `</div><div class="fx-card"><h4>Respiración y espacio</h4>
      ${slider('pulse', 'pulso', 1, 8, 0.1, prefs.pulse)}
      ${slider('refDistance', 'alcance pleno', 4, 80, 1, prefs.refDistance)}
      ${slider('influence', 'influjo', 60, 800, 10, prefs.influence)}
      ${slider('sunVolume', 'volumen', 0, 1.5, 0.05, prefs.sunVolume)}
      <p class="fx-note" style="margin:6px 0 0">Shift + arrastrar sobre un sol lo mueve por el espacio.</p></div>`;
    return html;
  }
  function slider(key, label, min, max, step, val) {
    return `<div class="fx-slider"><label>${label}</label><input type="range" data-a="pref" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${val}"><span class="v">${val}</span></div>`;
  }
  function viewRadio() {
    const rs = radios();
    let html = `<div class="fx-card acc-r"><h4>Forjar una radio</h4>
      <p class="fx-note">Una nebulosa majestuosa con corona solar que transmite en vivo desde su lugar en el cosmos. Podés forjar tantas como quieras; cada una corta su stream cuando salís de su influjo.</p>
      <input class="fx-in" id="fx-rname" placeholder="nombre (opcional)" maxlength="40">
      <input class="fx-in" id="fx-rurl" placeholder="stream (vacío = Radio Tagua Tagua)" style="margin-top:8px">
      <div class="fx-row" style="margin-top:10px"><button class="fx-btn r wide" data-a="r-create">Forjar frente a mí</button></div></div>
      <div class="fx-card"><h4>Radios<span class="n">${rs.length}</span></h4>`;
    html += rs.length ? rs.map(e => soundRow(e, COLORS.tagua)).join('') : `<div class="fx-empty">Ninguna radio forjada todavía.</div>`;
    html += `</div><div class="fx-card"><h4>Influjo de las radios</h4>
      ${slider('radioInfluence', 'influjo', 80, 1000, 10, prefs.radioInfluence)}
      ${slider('taguaVolume', 'volumen', 0, 1.5, 0.05, prefs.taguaVolume)}
      <p class="fx-note" style="margin:6px 0 0">Shift + arrastrar sobre una radio la mueve por el espacio.</p></div>`;
    return html;
  }
  function viewMapa() {
    const list = entities.map(e => ({ e, d: camera.position.distanceTo(e.obj.position) })).sort((a, b) => a.d - b.d);
    let html = `<div class="fx-card"><h4>Constelación<span class="n">${list.length}</span></h4>`;
    html += list.length ? list.map(({ e, d }) => `<div class="fx-item"><span class="fx-dot" style="color:${COLORS[e.kind === 'kairos' ? 'kairos' : e.kind]}"></span>
      <div class="fx-main"><div class="fx-title">${esc(e.name)}</div><div class="fx-meta">${e.kind === 'kairos' ? 'kairós' : e.kind === 'sun' ? 'sol de audio' : 'radio'} · <span data-dist="${e.id}">${Math.round(d)}</span> u</div></div>
      <div class="fx-acts">${entButtons(e)}</div></div>`).join('') : `<div class="fx-empty">El cielo espera su primera estrella.</div>`;
    html += `</div><div class="fx-card"><h4>Visión</h4>
      <label class="fx-toggle">Halo de plasma (más brillo, más gasto)<input type="checkbox" data-a="bloom" ${prefs.bloom ? 'checked' : ''} ${composer ? '' : 'disabled'}></label>
      <label class="fx-toggle">Radar<input type="checkbox" data-a="radar" ${prefs.radar ? 'checked' : ''}></label></div>
      <div class="fx-card"><h4>Gestos</h4><div class="fx-keys">
      <div><b>C</b>orbitar la estrella que mirás</div><div><b>Shift+C</b>salir de la órbita</div>
      <div><b>W S</b>acercarse / alejarse en órbita</div><div><b>A D Q E</b>girar alrededor · <b>Z X</b>subir / bajar</div>
      <div><b>click</b>en un video o texto: zoom</div><div><b>Enter</b>zoom al video más cercano</div>
      <div><b>Espacio</b>pausa el video en zoom</div><div><b>Esc</b>volver</div>
      <div><b>click</b>en un Kairós: grabar, escribir, subir video</div><div><b>click</b>en un sol o radio: encender / apagar</div>
      <div><b>arrastrar</b>un texto o video: cambiar su órbita</div><div><b>Shift+arrastrar</b>un Kairós, sol o radio: moverlo</div>
      <div><b>radar</b>click cambia el alcance</div></div></div>`;
    return html;
  }

  body.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, id = b.dataset.id, e = id ? entities.find(x => x.id === id) : null;
    if (a === 'hue') { newHue = b.dataset.hue; renderUI(); return; }
    if (a === 'k-create') { const n = $('fx-kname'); await createKairos(n ? n.value : '', newHue); return; }
    if (a === 'go' && e) { flyTo(e); return; }
    if (a === 'orbit' && e) { if (orbit && orbit.ent === e) exitOrbit(); else startOrbit(e); return; }
    if (a === 'ring' && e) { openRing(e); return; }
    if (a === 'expand') { expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderUI(); return; }
    if (a === 'del' && e) { if (confirm('¿Apagar ' + e.name + ' para siempre? Se borra todo lo que guarda.')) await deleteEntity(e); return; }
    if (a === 'm-open') { openArrived(id); return; }
    if (a === 'm-del') { if (confirm('¿Borrar este mensaje para siempre?')) await deleteMessage(id); return; }
    if (a === 's-play' && e) { await toggleSun(e); return; }
    if (a === 'bring' && e) { bringHere(e); return; }
    if (a === 'r-create') { await createRadio($('fx-rname').value, $('fx-rurl').value, true); return; }
    if (a === 'notif') {
      if (!('Notification' in window)) { toast('Este navegador no tiene avisos'); return; }
      if (prefs.notif && Notification.permission === 'granted') prefs.notif = false;
      else { const p = await Notification.requestPermission(); prefs.notif = p === 'granted'; }
      savePrefs(); renderUI(); return;
    }
  });
  body.addEventListener('change', async ev => {
    const t = ev.target, a = t.dataset.a;
    if (a === 's-file') { await createSunsFromFiles(t.files); t.value = ''; return; }
    if (a === 'sched') {
      const v = t.value;
      if (v === 'keep') return;
      if (v === 'custom') { customFor = t.dataset.id; renderUI(); return; }
      customFor = null;
      await scheduleMsg(t.dataset.id, v ? Date.now() + parseInt(v, 10) : 0); return;
    }
    if (a === 'sched-date') {
      const ts = new Date(t.value).getTime();
      if (!ts || ts <= Date.now()) { toast('Elegí una fecha en el futuro'); return; }
      customFor = null; t.blur(); await scheduleMsg(t.dataset.id, ts); return;
    }
    if (a === 'bloom') { prefs.bloom = t.checked; savePrefs(); return; }
    if (a === 'radar') { prefs.radar = t.checked; savePrefs(); $('fx-radar').style.display = prefs.radar ? '' : 'none'; return; }
  });
  body.addEventListener('input', ev => {
    const t = ev.target; if (t.dataset.a !== 'pref') return;
    const k = t.dataset.k, v = parseFloat(t.value);
    prefs[k] = v; savePrefs();
    const lab = t.parentElement.querySelector('.v'); if (lab) lab.textContent = v;
    if (k === 'pulse') sunConfig.pulse = v;
    entities.forEach(e => {
      if (e.kind === 'kairos') return;
      if (k === 'refDistance' || k === 'influence' || k === 'radioInfluence') e.obj.setPanner(prefs.refDistance, influenceOf(e));
      if (k === 'sunVolume' && e.kind === 'sun') e.obj.setVolume(v);
      if (k === 'taguaVolume' && e.kind === 'tagua') e.obj.setVolume(v);
    });
  });

  /* ---------------- anillo de acciones ---------------- */
  function toggleRing(k) { if (ringEnt === k) closeRing(); else openRing(k); }
  function openRing(k) { ringEnt = k; ring.querySelector('.nm').textContent = k.name.toUpperCase(); ring.classList.add('show'); refreshRing(); }
  function closeRing() { ringEnt = null; ring.classList.remove('show'); }
  function refreshRing() {
    if (!ringEnt) return;
    const k = ringEnt;
    const r = ring.querySelector('[data-r=rec]');
    const recOn = rec && rec.ent === k;
    r.classList.toggle('on', !!recOn); r.textContent = T(recOn ? '■' : '●');
    const p = ring.querySelector('[data-r=play]');
    const playOn = play && play.ent === k;
    p.classList.toggle('on', !!playOn); p.textContent = T(playOn ? '❚❚' : '▶');
    ring.querySelector('[data-r=msgs]').classList.toggle('on', k.obj.msgsVisible);
    ring.querySelector('[data-r=orbit]').classList.toggle('on', !!(orbit && orbit.ent === k));
    const c = countFor(k);
    ring.querySelector('.tip').textContent = recOn ? 'grabando...' : `${c.text} T · ${c.voice} ${T('●')} · ${c.video} ${T('▣')}`;
  }
  ring.addEventListener('click', ev => {
    const b = ev.target.closest('[data-r]'); if (!b || !ringEnt) return;
    const k = ringEnt, r = b.dataset.r;
    if (r === 'rec') toggleRecord(k);
    else if (r === 'text') openTextModal(k);
    else if (r === 'video') { videoTarget = k; $('fx-video-in').click(); }
    else if (r === 'play') togglePlayback(k);
    else if (r === 'msgs') { k.obj.setMessagesVisible(!k.obj.msgsVisible); refreshRing(); }
    else if (r === 'orbit') { if (orbit && orbit.ent === k) exitOrbit(); else startOrbit(k); }
    else if (r === 'close') closeRing();
  });
  const _sp = new V3();
  function positionRing() {
    if (!ringEnt) return;
    _sp.copy(ringEnt.obj.position).project(camera);
    if (_sp.z > 1 || Math.abs(_sp.x) > 1.3 || Math.abs(_sp.y) > 1.3) { ring.style.opacity = '0'; ring.style.pointerEvents = 'none'; return; }
    ring.style.opacity = '1';
    const x = (_sp.x + 1) / 2 * innerWidth, y = (1 - _sp.y) / 2 * innerHeight;
    const rw = 360;
    ring.style.left = Math.max(rw / 2 + 8, Math.min(innerWidth - rw / 2 - 8, x)) + 'px';
    ring.style.top = Math.max(60, Math.min(innerHeight - 140, y + 50)) + 'px';
  }

  /* ---------------- texto ---------------- */
  let textTarget = null, videoTarget = null;
  function openTextModal(k) {
    textTarget = k;
    $('fx-modal-title').textContent = 'MENSAJE AL FUTURO · ' + k.name.toUpperCase();
    $('fx-text').value = '';
    $('fx-modal').classList.add('show');
    setTimeout(() => $('fx-text').focus(), 60);
  }
  function closeTextModal() { $('fx-text').blur(); $('fx-modal').classList.remove('show'); textTarget = null; try { isTyping = false; } catch (e) {} }
  $('fx-modal').addEventListener('click', async ev => {
    const b = ev.target.closest('[data-m]');
    if (ev.target.id === 'fx-modal') { closeTextModal(); return; }
    if (!b) return;
    if (b.dataset.m === 'cancel') { closeTextModal(); return; }
    const v = $('fx-text').value.trim(), k = textTarget;
    closeTextModal();
    if (v && k) await commitMessage(k, { type: 'text', text: v });
  });
  $('fx-video-in').addEventListener('change', async ev => {
    const files = Array.from(ev.target.files || []); ev.target.value = '';
    const k = videoTarget; videoTarget = null;
    if (!k) return;
    for (const f of files) {
      if (!f.type.startsWith('video/')) continue;
      await commitMessage(k, { type: 'video', blob: f, name: f.name.replace(/\.[^.]+$/, '') });
    }
  });

  /* ---------------- barra de zoom ---------------- */
  function showZoomBar() {
    document.body.classList.add('fx-zooming');
    const s = zoom.sat;
    zbar.querySelector('.lbl').textContent = s.type === 'video' ? (s.name || 'video') : 'texto · ' + zoom.ent.name;
    zbar.querySelector('[data-z=play]').style.display = s.type === 'video' ? '' : 'none';
    zbar.querySelector('[data-z=seek]').style.display = s.type === 'video' ? '' : 'none';
    zbar.querySelector('[data-z=sound]').style.display = s.type === 'video' ? '' : 'none';
    zbar.classList.add('show'); updateZoomBar();
  }
  function hideZoomBar() { zbar.classList.remove('show'); document.body.classList.remove('fx-zooming'); }
  function updateZoomBar() {
    if (!zoom || !zoom.sat.live) return;
    const el = zoom.sat.live.el;
    zbar.querySelector('[data-z=play]').textContent = T(el.paused ? '▶' : '❚❚');
    zbar.querySelector('[data-z=sound]').classList.toggle('on', !el.muted);
    if (!seeking && isFinite(el.duration) && el.duration > 0) zbar.querySelector('[data-z=seek]').value = Math.round(el.currentTime / el.duration * 1000);
  }
  let seeking = false;
  zbar.addEventListener('click', ev => {
    const b = ev.target.closest('[data-z]'); if (!b) return;
    const z = b.dataset.z;
    if (z === 'close') unzoom();
    else if (z === 'play') toggleZoomVideo();
    else if (z === 'sound' && zoom && zoom.sat.live) { zoom.sat.live.el.muted = !zoom.sat.live.el.muted; updateZoomBar(); }
  });
  const seek = zbar.querySelector('[data-z=seek]');
  seek.addEventListener('input', () => {
    seeking = true;
    if (zoom && zoom.sat.live) { const el = zoom.sat.live.el; if (isFinite(el.duration)) el.currentTime = seek.value / 1000 * el.duration; }
  });
  seek.addEventListener('change', () => { seeking = false; });

  /* ---------------- controles táctiles ---------------- */
  (function joystick() {
    const joy = $('fx-joy'), knob = joy.querySelector('i');
    let id = null, cx = 0, cy = 0;
    const set = (dx, dy) => {
      const d = Math.hypot(dx, dy), m = 34;
      if (d > m) { dx = dx / d * m; dy = dy / d * m; }
      knob.style.transform = `translate(${dx}px,${dy}px)`;
      const th = m * 0.25;
      moveForward = dy < -th; moveBackward = dy > th; moveLeft = dx < -th; moveRight = dx > th;
    };
    joy.addEventListener('pointerdown', e => {
      id = e.pointerId; joy.setPointerCapture(id);
      const r = joy.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      set(e.clientX - cx, e.clientY - cy); e.preventDefault();
    });
    joy.addEventListener('pointermove', e => { if (e.pointerId === id) set(e.clientX - cx, e.clientY - cy); });
    const end = e => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; moveForward = moveBackward = moveLeft = moveRight = false; };
    joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
    const tb = $('fx-tbtns');
    const hold = (sel, on) => {
      const b = tb.querySelector(sel);
      b.addEventListener('pointerdown', e => { e.preventDefault(); on(true); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(x => b.addEventListener(x, () => on(false)));
    };
    hold('[data-t=up]', v => { moveUp = v; });
    hold('[data-t=down]', v => { moveDown = v; });
    tb.querySelector('[data-t=orbit]').addEventListener('click', () => {
      if (zoom) { unzoom(); return; }
      if (orbit) exitOrbit(); else { const e = nearestOrbitable(true); if (e) startOrbit(e); else toast('No hay estrellas cerca para orbitar'); }
    });
  })();

  /* =====================================================================
     RADAR
     ===================================================================== */
  const radarBox = $('fx-radar'), radarCv = $('fx-radar-cv'), rctx = radarCv.getContext('2d');
  function layoutRadar() {
    const size = prefs.radarMini ? 54 : (innerWidth < 600 ? 104 : 136);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    radarCv.width = radarCv.height = Math.round(size * dpr);
    radarCv.style.width = radarCv.style.height = size + 'px';
    radarBox.classList.toggle('small', prefs.radarMini);
    radarBox.querySelector('.mini').textContent = prefs.radarMini ? '+' : '–';
  }
  layoutRadar();
  radarBox.style.display = prefs.radar ? '' : 'none';
  radarCv.addEventListener('click', () => {
    prefs.radarRange = (prefs.radarRange + 1) % CFG.radarRanges.length; savePrefs();
    toast('Radar: alcance ' + CFG.radarRanges[prefs.radarRange] + ' u', 1400);
  });
  radarBox.querySelector('.mini').addEventListener('click', () => { prefs.radarMini = !prefs.radarMini; savePrefs(); layoutRadar(); });

  function drawRadar(t) {
    if (!prefs.radar) return;
    const W = radarCv.width, c = rctx, cx = W / 2, R = W / 2 - 3 * (W / 136);
    const u = W / 136;
    c.clearRect(0, 0, W, W);
    const g = c.createRadialGradient(cx, cx, 0, cx, cx, R);
    g.addColorStop(0, 'rgba(10,30,50,.75)'); g.addColorStop(1, 'rgba(2,8,18,.82)');
    c.fillStyle = g; c.beginPath(); c.arc(cx, cx, R, 0, 7); c.fill();
    c.strokeStyle = 'rgba(77,219,255,.35)'; c.lineWidth = 1 * u; c.stroke();
    c.strokeStyle = 'rgba(77,219,255,.12)';
    [R / 3, 2 * R / 3].forEach(r => { c.beginPath(); c.arc(cx, cx, r, 0, 7); c.stroke(); });
    c.beginPath(); c.moveTo(cx - R, cx); c.lineTo(cx + R, cx); c.moveTo(cx, cx - R); c.lineTo(cx, cx + R); c.stroke();
    // barrido
    const sw = (t * 0.9) % (Math.PI * 2);
    const sg = c.createLinearGradient(cx, cx, cx + Math.cos(sw) * R, cx + Math.sin(sw) * R);
    sg.addColorStop(0, 'rgba(77,219,255,0)'); sg.addColorStop(1, 'rgba(77,219,255,.25)');
    c.strokeStyle = sg; c.lineWidth = 2 * u; c.beginPath(); c.moveTo(cx, cx); c.lineTo(cx + Math.cos(sw) * R, cx + Math.sin(sw) * R); c.stroke();
    // vos
    c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(cx, cx - 6 * u); c.lineTo(cx - 4 * u, cx + 4 * u); c.lineTo(cx + 4 * u, cx + 4 * u); c.closePath(); c.fill();

    const f = camForward(); f.y = 0;
    if (f.lengthSq() < 1e-4) f.set(0, 0, -1);
    f.normalize();
    const rx = -f.z, rz = f.x; // derecha en el plano
    const range = CFG.radarRanges[prefs.radarRange], scale = R / range;
    const cam = camera.position;
    for (const e of entities) {
      const p = e.obj.position;
      const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
      const lx = dx * rx + dz * rz, ly = dx * f.x + dz * f.z;
      let px = lx * scale, py = -ly * scale;
      const d = Math.hypot(px, py);
      const col = COLORS[e.kind === 'kairos' ? 'kairos' : e.kind];
      c.fillStyle = col; c.strokeStyle = col;
      if (d > R - 5 * u) {
        const a = Math.atan2(py, px), rr = R - 5 * u;
        px = Math.cos(a) * rr; py = Math.sin(a) * rr;
        c.save(); c.translate(cx + px, cx + py); c.rotate(a + Math.PI / 2);
        c.globalAlpha = 0.85; c.beginPath(); c.moveTo(0, -4 * u); c.lineTo(-3 * u, 2 * u); c.lineTo(3 * u, 2 * u); c.closePath(); c.fill();
        c.restore(); c.globalAlpha = 1;
      } else {
        const playing = (e.kind !== 'kairos' && e.obj.playing) || (e.kind === 'kairos' && e.chain && !e.chain.el.paused);
        const r0 = (e.kind === 'tagua' ? 4 : e.kind === 'sun' ? 3.4 : 3) * u;
        const pr = playing ? r0 * (1 + 0.3 * Math.sin(t * 6)) : r0;
        c.shadowColor = col; c.shadowBlur = 8 * u;
        c.beginPath(); c.arc(cx + px, cx + py, pr, 0, 7); c.fill();
        c.shadowBlur = 0;
        if (Math.abs(dy) > 15) { // por encima / por debajo
          c.beginPath(); const s = dy > 0 ? -1 : 1;
          c.moveTo(cx + px, cx + py + s * (pr + 1 * u)); c.lineTo(cx + px, cx + py + s * (pr + 5 * u)); c.lineWidth = 1.2 * u; c.stroke();
        }
      }
      if (orbit && orbit.ent === e) { c.lineWidth = 1.2 * u; c.beginPath(); c.arc(cx + px, cx + py, 7 * u, 0, 7); c.stroke(); }
    }
    c.fillStyle = 'rgba(220,240,255,.55)'; c.font = `${9 * u}px "Share Tech Mono", monospace`; c.textAlign = 'center';
    if (!prefs.radarMini) c.fillText(range + ' u', cx, cx + R - 6 * u);
  }

  /* =====================================================================
     API PARA MUNDO INTERIOR
     ===================================================================== */
  function onKey(e) {
    if ($('fx-modal').classList.contains('show')) return e.code === 'Escape' ? (closeTextModal(), true) : false;
    const code = e.code;
    if (code === 'KeyC' && !e.ctrlKey && !e.metaKey) {
      if (zoom) unzoom(true);
      if (e.shiftKey || orbit) { exitOrbit(); return true; }
      const target = (hovered && hovered.ent) || nearestOrbitable(true);
      if (target) startOrbit(target); else toast('No hay estrellas para orbitar todavía');
      return true;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      if (zoom) { unzoom(); return true; }
      const z = nearestZoomable();
      if (z) { zoomTo(z.ent, z.sat); return true; }
      return false;
    }
    if (code === 'Space' && zoom) { e.preventDefault(); toggleZoomVideo(); return true; }
    if (code === 'Escape') {
      if (zoom) { unzoom(); return true; }
      if (orbit) { exitOrbit(); return true; }
      if (ringEnt) { closeRing(); return true; }
      if (drawer.classList.contains('open')) { drawer.classList.remove('open'); return true; }
      return false;
    }
    if (zoom && /^(Key[WASDQEZX])$/.test(code)) return true; // en zoom el teclado no mueve
    return false;
  }

  let uiTick = 0;
  function update(dt) {
    frame++;
    dt = Math.min(dt || 0.016, 0.05);
    const t = clockT.getElapsedTime();
    const camPos = camera.position;
    for (const e of entities) {
      if (e.kind === 'kairos') e.obj.update(t, dt, kairosLevel(e), camPos, e.chain && !e.chain.el.paused ? e.chain.msgId : null);
      else e.obj.update(t, dt, camPos);
    }
    if (frame % 5 === 0) updateVideoLOD(t);
    if (frame % 6 === 0) updateInfluence();
    if (frame % 3 === 0) updateHover();
    if (flight && !orbit && !zoom) stepFlight(dt);
    let owns = false;
    if (zoom) { stepZoom(dt); owns = !!zoom || !!orbit; if (!zoom && orbit) { stepOrbit(dt); } }
    else if (orbit) { stepOrbit(dt); owns = true; }
    positionRing();
    if (frame % 2 === 0) drawRadar(t);
    if (zoom && frame % 10 === 0) updateZoomBar();
    uiTick += dt;
    if (uiDirty) renderUI();
    if (uiTick > 1 && drawer.classList.contains('open')) { uiTick = 0; updateDistances(); }
    if (ringEnt && frame % 30 === 0) refreshRing();
    return owns;
  }
  function render() {
    if (bloomPass) { // el halo baja al mirar un video de cerca para no quemarlo
      const target = zoom && zoom.sat.type === 'video' ? 0.12 : 0.9;
      bloomPass.strength += (target - bloomPass.strength) * 0.12;
    }
    if (prefs.bloom && composer) composer.render();
    else webglRenderer.render(scene, camera);
  }

  window.Forja = {
    ready: false,
    update, render, onKey,
    ownsCamera: () => !!(orbit || zoom),
    drag(dx, dy) { if (orbit && !zoom) orbitDrag(dx, dy, 0.005); },
    wheel(dy) { if (orbit || zoom) { wheelLike(dy); return true; } return false; },
    // para el puente de sockets / otros módulos
    entities: () => entities.map(e => ({ id: e.id, kind: e.kind, name: e.name, position: e.obj.position.toArray(), playing: !!e.obj.playing })),
    createKairos, orbit: id => startOrbit(entities.find(e => e.id === id)), exitOrbit,
    createRadio, toggleSound: id => { const e = entities.find(x => x.id === id); if (e && e.kind !== 'kairos') toggleSun(e); },
    isGrabbing: () => !!grab, flyTo: id => { const e = entities.find(x => x.id === id); if (e) flyTo(e); }
  };

  /* =====================================================================
     DESPERTAR: restaurar el cielo guardado
     ===================================================================== */
  (async function restore() {
    try {
      const ents = (await DB.all('entities')).sort((a, b) => a.createdAt - b.createdAt);
      for (const r of ents) {
        if (r.kind === 'kairos') spawnKairos(r);
        else if (r.kind === 'sun' || r.kind === 'tagua') spawnSun(r);
      }
      const ms = (await DB.all('messages')).sort((a, b) => a.createdAt - b.createdAt);
      for (const m of ms) {
        msgs.set(m.id, m);
        const k = entities.find(e => e.id === m.kairosId);
        if (k) attachSat(k, m);
      }
      entities.filter(e => e.kind === 'kairos').forEach(k => k.obj.setResonance(countFor(k).total));
      const tg = safeJSON(localStorage.getItem('forja_tagua_v1'));   // migración: la antigua radio única
      if (tg && tg.position && !entities.some(e => e.kind === 'tagua')) {
        const rec = { id: 'tagua', kind: 'tagua', name: 'Radio Tagua Tagua', url: L.TAGUA_URL, createdAt: Date.now(), position: tg.position };
        await DB.put('entities', rec); spawnSun(rec);
      }
      try { localStorage.removeItem('forja_tagua_v1'); } catch (e) {}
      if (tg && tg.position) spawnSun({ id: 'tagua', kind: 'tagua', name: 'Radio Tagua Tagua', position: tg.position });
    } catch (e) { console.warn('[Forja] no pude restaurar el cielo:', e); }
    window.Forja.ready = true;
    checkArrivals();
    refreshUI();
    console.log('%c✦ Forja Estelar activa — ' + entities.length + ' cuerpos en el cielo', 'color:#00e8c8;font-size:11px;');
  })();
})();

/* ==========================================================================
   FORJA ESTELAR · KAIRÓS
   Estrellas de plasma (herencia de kairos.html) con memoria orbital:
   tarjetas de texto, soles de voz y pantallas de video que orbitan.
   Incluye el almacén IndexedDB, la grabadora y el extractor de fotogramas.
   Three.js r128 por script-tag. Expone window.ForjaLib.{DB, KairosStar,
   Recorder, extractFrames, HUES}.
   ========================================================================== */
(function () {
  'use strict';
  const NS = window.ForjaLib = window.ForjaLib || {};

  /* ---------------------------------------------------------------------
     1. ALMACÉN
     --------------------------------------------------------------------- */
  const DB_NAME = 'mundointerior_forja', DB_VER = 1;
  let _db = null;
  function openDB() {
    return new Promise((res, rej) => {
      if (_db) return res(_db);
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        ['entities', 'messages', 'blobs'].forEach(s => {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
        });
      };
      r.onsuccess = e => { _db = e.target.result; res(_db); };
      r.onerror = e => rej(e.target.error);
    });
  }
  function run(store, mode, fn) {
    return openDB().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }
  NS.DB = {
    put: (s, v) => run(s, 'readwrite', st => st.put(v)),
    get: (s, id) => run(s, 'readonly', st => st.get(id)).then(r => r || null),
    all: s => run(s, 'readonly', st => st.getAll()).then(r => r || []),
    del: (s, id) => run(s, 'readwrite', st => st.delete(id))
  };

  /* ---------------------------------------------------------------------
     2. PALETAS Y TEXTURAS
     --------------------------------------------------------------------- */
  const HUES = {
    calipso: { label: 'Calipso', a: '#00e8c8', b: '#8dfff0', halo: '#00a88f', alt: '#9b6bff' },
    violeta: { label: 'Violeta', a: '#9b6bff', b: '#d6c8ff', halo: '#5e36c9', alt: '#00e8c8' },
    ambar:   { label: 'Ámbar',   a: '#ffb347', b: '#ffe2a8', halo: '#c07a10', alt: '#ff6fa8' },
    rosa:    { label: 'Rosa',    a: '#ff6fa8', b: '#ffc6de', halo: '#c0306e', alt: '#ffd34d' }
  };
  NS.HUES = HUES;

  function rgba(hex, a) {
    const c = new THREE.Color(hex);
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
  }
  const texCache = {};
  function radialTex(key, c1, c2) {
    if (texCache[key]) return texCache[key];
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, c1); gr.addColorStop(0.4, c2); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return (texCache[key] = new THREE.CanvasTexture(c));
  }
  function streakTex() {
    if (texCache.streak) return texCache.streak;
    const c = document.createElement('canvas'); c.width = 256; c.height = 32;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 256, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 8, 256, 16);
    return (texCache.streak = new THREE.CanvasTexture(c));
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function cardTexture(text, P, glow) {
    const S = 2, font = `${19 * S}px "Share Tech Mono", monospace`;
    const maxW = 300 * S, padX = 20 * S, padY = 18 * S, lh = 25 * S;
    const m = document.createElement('canvas').getContext('2d'); m.font = font;
    const words = (text || '').split(/\s+/);
    let lines = [], line = '';
    words.forEach(w => {
      const t = line ? line + ' ' + w : w;
      if (m.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    if (lines.length > 7) { lines = lines.slice(0, 7); lines[6] = lines[6].replace(/.?$/, '…'); }
    const widest = lines.reduce((a, l) => Math.max(a, m.measureText(l).width), 40 * S);
    const w = Math.round(Math.min(340 * S, Math.max(120 * S, widest + padX * 2)));
    const h = Math.round(padY * 2 + lines.length * lh);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(4,18,20,0.66)'; roundRect(g, 4, 4, w - 8, h - 8, 14 * S); g.fill();
    g.strokeStyle = glow ? '#ffd34d' : rgba(P.b, 0.9); g.lineWidth = (glow ? 3.4 : 2.2) * S;
    roundRect(g, 4, 4, w - 8, h - 8, 14 * S); g.stroke();
    g.fillStyle = '#e4fff8'; g.font = font; g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, padX, padY - 2 * S + i * lh));
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    return { tex, w: w / S, h: h / S };
  }
  function placeholderTex(P) {
    const key = 'ph' + P.a;
    if (texCache[key]) return texCache[key];
    const c = document.createElement('canvas'); c.width = 256; c.height = 144;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 256, 144);
    gr.addColorStop(0, '#040c14'); gr.addColorStop(1, '#0a1a24');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 144);
    g.fillStyle = rgba(P.b, 0.9); g.font = '40px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('▷︎', 128, 64);
    g.font = '13px monospace'; g.fillStyle = rgba(P.b, 0.6);
    g.fillText('revelando fotogramas', 128, 108);
    const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter;
    return (texCache[key] = t);
  }
  function frameTex(P, aspect) {
    const key = 'fr' + P.a + aspect.toFixed(1);
    if (texCache[key]) return texCache[key];
    const W = 320, H = Math.round(W / aspect);
    const c = document.createElement('canvas'); c.width = W + 24; c.height = H + 24;
    const g = c.getContext('2d');
    g.shadowColor = P.a; g.shadowBlur = 10;
    g.strokeStyle = rgba(P.b, 0.95); g.lineWidth = 3;
    roundRect(g, 10, 10, W + 4, H + 4, 8); g.stroke();
    const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter;
    return (texCache[key] = t);
  }

  /* pseudo-azar estable por id (las órbitas no saltan al recargar) */
  function seeded(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
  }
  function organic(t, s) {
    return Math.sin(t * 0.37 + s) * 0.5 + Math.sin(t * 0.71 + s * 1.37) * 0.3 +
           Math.sin(t * 1.23 + s * 2.11) * 0.15 + Math.sin(t * 0.19 + s * 0.53) * 0.25;
  }

  /* ---------------------------------------------------------------------
     3. ESTRELLA KAIRÓS
     --------------------------------------------------------------------- */
  const K = 0.3; // escala respecto del púlsar original de kairos.html
  const GOLD = Math.PI * (3 - Math.sqrt(5));
  let ringGeo = null;

  class KairosStar {
    constructor(scene, position, hueKey) {
      this.scene = scene;
      this.hueKey = HUES[hueKey] ? hueKey : 'calipso';
      const P = this.P = HUES[this.hueKey];
      this.group = new THREE.Object3D();
      this.group.position.copy(position);
      this.position = this.group.position;
      scene.add(this.group);
      this.radius = 24;

      const hot = radialTex('hot' + this.hueKey, 'rgba(255,255,255,1)', rgba(P.a, 0.9));
      const glow = this.glowTex = radialTex('glow' + this.hueKey, rgba(P.b, 0.95), rgba(P.a, 0.5));
      this.voiceTex = radialTex('voice' + this.hueKey, rgba('#ffffff', 0.95), rgba(P.alt, 0.5));
      const spr = (map, color, op, s) => {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map, color: new THREE.Color(color), blending: THREE.AdditiveBlending,
          transparent: true, depthWrite: false, opacity: op, fog: false
        }));
        sp.scale.set(s, s, 1); this.group.add(sp); return sp;
      };
      this.core = spr(hot, '#ffffff', 1, 14 * K);
      this.boilA = spr(glow, P.a, 0.7, 20 * K);
      this.boilB = spr(glow, P.b, 0.55, 24 * K);
      this.plasma = spr(glow, P.a, 0.85, 36 * K);
      this.halo = spr(glow, P.halo, 0.32, 82 * K);
      this.plasmaHSL = {}; new THREE.Color(P.a).getHSL(this.plasmaHSL);

      this.filaments = []; // sin filamentos: solo el núcleo plasmático y su corona
      this.coronaIn = this._corona(700, 16 * K, 34 * K, P.b, P.a, 1.9 * K, glow);
      this.coronaOut = this._corona(500, 34 * K, 62 * K, P.alt, P.halo, 2.6 * K, glow);

      this.hit = new THREE.Mesh(new THREE.SphereGeometry(9, 12, 10), new THREE.MeshBasicMaterial({ visible: false }));
      this.group.add(this.hit);

      this.flashE = 0; this.flashT = 0; this.feedE = 0; this.feedT = 0;
      this.baseScale = 1; this.baseScaleT = 1;
      this.lastBeat = 0;
      this.sats = [];
      this.msgsVisible = true;
    }

    _corona(n, rMin, rMax, cA, cB, size, map) {
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      const a = new THREE.Color(cA), b = new THREE.Color(cB);
      for (let i = 0; i < n; i++) {
        const t = i / n, r = rMin + Math.pow(t, 0.5) * (rMax - rMin) + (Math.random() - 0.5) * 3 * K, th = i * GOLD;
        pos[i * 3] = Math.cos(th) * r; pos[i * 3 + 1] = (Math.random() - 0.5) * (rMax - rMin) * 0.35; pos[i * 3 + 2] = Math.sin(th) * r;
        const m = a.clone().lerp(b, Math.random());
        col[i * 3] = m.r; col[i * 3 + 1] = m.g; col[i * 3 + 2] = m.b;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const p = new THREE.Points(g, new THREE.PointsMaterial({
        map, size, vertexColors: true, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, fog: false
      }));
      this.group.add(p);
      return p;
    }

    setResonance(n) { this.baseScaleT = 1 + Math.min(n, 80) * 0.007; }
    flash() { this.flashT = 1; }
    feed() { this.feedT = 1; this.flashT = Math.max(this.flashT, 0.7); }

    update(t, dt, level, camPos, playingMsgId) {
      level = level || 0;
      const breathe = 1 + organic(t, 0) * 0.055;
      this.flashE += (this.flashT - this.flashE) * 0.1;
      this.feedE += (this.feedT - this.feedE) * 0.06;
      this.baseScale += (this.baseScaleT - this.baseScale) * 0.04;
      if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - 0.02);
      if (this.feedT > 0) this.feedT = Math.max(0, this.feedT - 0.01);
      const spike = this.flashE, feed = this.feedE;
      const s = this.baseScale * breathe * (1 + spike * 0.6) * (1 + level * 0.42);
      const c = 14 * K * s * (1 + spike * 0.9 + feed * 0.4 + level * 0.5);
      this.core.scale.set(c, c, 1);
      const a = 20 * K * s * (1 + organic(t, 1.7) * 0.1); this.boilA.scale.set(a, a, 1); this.boilA.material.rotation = t * 0.4;
      const b = 24 * K * s * (1 + organic(t, 3.4) * 0.09); this.boilB.scale.set(b, b, 1); this.boilB.material.rotation = -t * 0.3;
      const p = 36 * K * s * (1 + level * 0.18); this.plasma.scale.set(p, p, 1);
      const h = 82 * K * s * (1 + spike * 0.4 + level * 0.22); this.halo.scale.set(h, h, 1);
      const H = this.plasmaHSL;
      this.plasma.material.color.setHSL(H.h - feed * 0.02 - level * 0.01, Math.min(1, H.s * 0.9), Math.min(0.8, H.l * 0.95 + feed * 0.15 + level * 0.1));
      this.plasma.material.opacity = 0.75 + organic(t, 5.1) * 0.1 + spike * 0.2 + level * 0.22;
      this.halo.material.opacity = 0.28 + organic(t, 7.2) * 0.07 + spike * 0.25 + feed * 0.15 + level * 0.28;
      for (const sp of this.filaments) {
        const ang = sp.userData.a + t * sp.userData.sp, r = sp.userData.r * s;
        sp.position.set(Math.cos(ang) * r, Math.sin(t * 0.5 + sp.userData.a) * 4 * K, Math.sin(ang) * r);
        sp.material.rotation = ang * 1.3;
        sp.material.opacity = 0.4 + organic(t, sp.userData.a) * 0.15 + spike * 0.3 + level * 0.25;
        sp.scale.x = (46 + feed * 20 + level * 22) * K * s * 0.5;
      }
      this.coronaIn.rotation.y = t * 0.09; this.coronaIn.rotation.x = Math.sin(t * 0.15) * 0.08;
      this.coronaIn.material.size = (1.9 + spike * 1.2 + feed * 0.8 + level * 1.8) * K;
      this.coronaOut.rotation.y = -t * 0.045;
      this.coronaOut.material.size = (2.6 + spike * 1.4 + level * 1.1) * K;

      const near = camPos ? camPos.distanceTo(this.position) < 240 : true;
      if (near && t - this.lastBeat > 3.2) { this.lastBeat = t; this._beat(); }
      this._updateSats(t, dt, level, playingMsgId);
    }

    _beat() {
      if (!ringGeo) ringGeo = new THREE.RingGeometry(0.5, 1, 48);
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(this.P.halo), transparent: true, opacity: 0.3, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false
      }));
      ring.rotation.x = -Math.PI / 2;
      this.group.add(ring);
      const t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / 2600), sc = 1 + k * 30;
        ring.scale.set(sc, sc, sc); ring.material.opacity = 0.3 * (1 - k);
        if (k < 1) requestAnimationFrame(step); else { this.group.remove(ring); ring.material.dispose(); }
      };
      requestAnimationFrame(step);
    }

    absorb() {
      const n = 48, starts = new Float32Array(n * 3), cur = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, el = Math.random() * Math.PI - Math.PI / 2, r = (44 + Math.random() * 16) * K;
        starts[i * 3] = Math.cos(a) * Math.cos(el) * r; starts[i * 3 + 1] = Math.sin(el) * r; starts[i * 3 + 2] = Math.sin(a) * Math.cos(el) * r;
      }
      cur.set(starts);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(cur, 3));
      const m = new THREE.PointsMaterial({ map: radialTex('hot' + this.hueKey, 'rgba(255,255,255,1)', rgba(this.P.a, 0.9)),
        size: 3.6 * K, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      const pts = new THREE.Points(g, m);
      this.group.add(pts);
      const t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / 1400);
        for (let i = 0; i < n * 3; i++) cur[i] = starts[i] * (1 - k);
        g.attributes.position.needsUpdate = true; m.opacity = 0.95 * (1 - k * 0.7);
        if (k < 1) requestAnimationFrame(step); else { this.group.remove(pts); g.dispose(); m.dispose(); this.feed(); }
      };
      requestAnimationFrame(step);
    }

    /* ---------------- satélites ---------------- */
    addSatellite(msg) {
      const P = this.P, rnd = seeded(msg.id);
      const idx = this.sats.filter(s => s.type === msg.type).length;
      const sat = { type: msg.type, msgId: msg.id, frozen: false, angle: idx * GOLD + rnd() * 0.6, arrived: false, highlight: 0 };
      if (msg.type === 'text') {
        const { tex, w, h } = cardTexture(msg.text, P, false);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
        sat.w = w / 30; sat.h = h / 30;
        sp.scale.set(sat.w, sat.h, 1);
        sat.obj = sat.pick = sp; sat.text = msg.text;
        sat.radius = 22 + (idx % 4) * 2.8; sat.height = (rnd() - 0.5) * 10 + 2; sat.speed = 0.025 + rnd() * 0.015;
      } else if (msg.type === 'voice') {
        const o = new THREE.Object3D();
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.voiceTex, color: new THREE.Color(P.alt),
          blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.75, fog: false }));
        halo.scale.set(2.4, 2.4, 1);
        const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.voiceTex, color: 0xffffff,
          blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
        core.scale.set(0.9, 0.9, 1);
        o.add(halo); o.add(core);
        sat.obj = o; sat.pick = halo; sat.halo = halo;
        sat.radius = 14 + (idx % 4) * 2.2; sat.height = (rnd() - 0.5) * 7 - 2; sat.speed = 0.05 + rnd() * 0.02;
        sat.phase = rnd() * 6.28;
      } else {
        const o = new THREE.Object3D();
        const screen = new THREE.Sprite(new THREE.SpriteMaterial({ map: placeholderTex(P), fog: false, depthWrite: true }));
        const frame = new THREE.Sprite(new THREE.SpriteMaterial({ map: frameTex(P, 16 / 9), transparent: true, depthWrite: false, fog: false }));
        frame.renderOrder = 2;
        o.add(screen); o.add(frame);
        sat.obj = o; sat.pick = screen; sat.screen = screen; sat.frameSp = frame;
        sat.radius = 32 + (idx % 3) * 5; sat.height = (rnd() - 0.5) * 8 + 4; sat.speed = 0.012 + rnd() * 0.008;
        sat.phase = rnd() * 8; sat.name = msg.name || 'video';
        this.setVideoAspect(sat, 16 / 9);
      }
      sat.pick.userData.sat = sat;
      sat.obj.visible = this.msgsVisible;
      this._placeSat(sat);
      this.group.add(sat.obj);
      this.sats.push(sat);
      return sat;
    }

    setVideoAspect(sat, aspect) {
      aspect = Math.max(0.4, Math.min(2.6, aspect || 16 / 9));
      sat.aspect = aspect;
      sat.h = 5; sat.w = Math.min(9.5, sat.h * aspect);
      sat.h = sat.w / aspect;
      sat.screen.scale.set(sat.w, sat.h, 1);
      const W = 320, H = Math.round(W / aspect);
      sat.frameSp.material.map = frameTex(this.P, aspect);
      sat.frameSp.material.needsUpdate = true;
      sat.frameSp.scale.set(sat.w * (W + 24) / W, sat.h * (H + 24) / H, 1);
    }
    setScreenMap(sat, tex) {
      if (!sat.screen || sat.screen.material.map === tex) return;
      sat.screen.material.map = tex;
      sat.screen.material.needsUpdate = true;
    }
    markArrived(msgId, on) {
      const s = this.sats.find(x => x.msgId === msgId);
      if (!s) return;
      s.arrived = on;
      if (s.type === 'text') {
        const { tex } = cardTexture(s.text, this.P, on);
        const old = s.obj.material.map; s.obj.material.map = tex; s.obj.material.needsUpdate = true; old.dispose();
      }
    }
    highlight(msgId) { const s = this.sats.find(x => x.msgId === msgId); if (s) s.highlight = 1; }
    removeSatellite(msgId) {
      const i = this.sats.findIndex(s => s.msgId === msgId);
      if (i < 0) return null;
      const s = this.sats[i];
      this.group.remove(s.obj);
      if (s.type === 'text') s.obj.material.map.dispose();
      s.obj.traverse(o => { if (o.material) o.material.dispose(); });
      s.dead = true;
      this.sats.splice(i, 1);
      return s;
    }
    setMessagesVisible(v) {
      this.msgsVisible = v;
      this.sats.forEach(s => { s.obj.visible = v; });
    }
    _placeSat(s) {
      const bob = s.type === 'voice' ? 3 : 4;
      s.obj.position.set(Math.cos(s.angle) * s.radius, s.height + Math.sin(s.angle * 2.3) * bob * 0.5, Math.sin(s.angle) * s.radius);
    }
    _updateSats(t, dt, level, playingId) {
      for (const s of this.sats) {
        if (!s.frozen) { s.angle += dt * s.speed; this._placeSat(s); }
        if (s.highlight > 0) s.highlight = Math.max(0, s.highlight - dt * 0.25);
        const pulseArr = s.arrived ? 1 + Math.sin(t * 3) * 0.12 : 1;
        const hl = 1 + s.highlight * 0.35;
        if (s.type === 'voice') {
          const playing = s.msgId === playingId;
          const pl = 1 + Math.sin(t * 1.8 + s.phase) * 0.15 + (playing ? level * 1.1 : 0);
          const k = 2.4 * pl * pulseArr * hl;
          s.halo.scale.set(k, k, 1);
          s.halo.material.opacity = playing ? Math.min(1, 0.7 + level * 0.5) : 0.75;
        } else if (s.type === 'text') {
          s.obj.scale.set(s.w * pulseArr * hl, s.h * pulseArr * hl, 1);
        } else {
          s.obj.scale.setScalar(pulseArr * hl);
        }
      }
    }

    dispose() {
      this.sats.slice().forEach(s => this.removeSatellite(s.msgId));
      this.scene.remove(this.group);
      this.group.traverse(o => { if (o.geometry && o.geometry !== ringGeo) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
  }
  NS.KairosStar = KairosStar;

  /* ---------------------------------------------------------------------
     4. GRABADORA DE VOZ
     --------------------------------------------------------------------- */
  class Recorder {
    constructor(ctx) {
      this.ctx = ctx; this.analyser = null; this.data = null; this.src = null;
    }
    async start() {
      let inFrame = false;
      try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
      if (!window.isSecureContext) return { ok: false, msg: 'El micrófono necesita HTTPS (GitHub Pages) o http://localhost.' };
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { ok: false, msg: 'Este navegador no permite grabar audio.' };
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const n = err && err.name;
        const msg = n === 'NotAllowedError' ? (inFrame ? 'Permiso bloqueado: esta vista corre dentro de un iframe. Abrí Mundo Interior en su propia pestaña.' : 'Permiso de micrófono bloqueado. Revisá el candado de la barra de direcciones.')
          : n === 'NotFoundError' ? 'No encontré un micrófono.'
          : n === 'NotReadableError' ? 'Otra aplicación está usando el micrófono.'
          : 'No pude abrir el micrófono (' + (n || 'error') + ').';
        return { ok: false, msg };
      }
      const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      this.mime = (window.MediaRecorder && MediaRecorder.isTypeSupported) ? (cands.find(c => MediaRecorder.isTypeSupported(c)) || '') : '';
      this.rec = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream);
      this.chunks = [];
      this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
      try {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 128; this.analyser.smoothingTimeConstant = 0.75;
        this.data = new Uint8Array(this.analyser.frequencyBinCount);
        this.src = this.ctx.createMediaStreamSource(this.stream);
        this.src.connect(this.analyser); // sin destino: no hay eco
      } catch (e) { this.analyser = null; }
      this.rec.start();
      return { ok: true };
    }
    level() {
      if (!this.analyser) return 0;
      this.analyser.getByteFrequencyData(this.data);
      let s = 0; for (let i = 0; i < this.data.length; i++) s += this.data[i];
      return s / this.data.length / 255;
    }
    stop() {
      return new Promise(res => {
        if (!this.rec) return res(null);
        this.rec.onstop = () => {
          try { this.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
          try { this.src && this.src.disconnect(); } catch (e) {}
          const blob = this.chunks.length ? new Blob(this.chunks, { type: this.mime || 'audio/webm' }) : null;
          res(blob && blob.size ? blob : null);
        };
        try { this.rec.stop(); } catch (e) { res(null); }
      });
    }
  }
  NS.Recorder = Recorder;

  /* ---------------------------------------------------------------------
     5. EXTRACTOR DE FOTOGRAMAS (secuencia que se ve al acercarse)
     --------------------------------------------------------------------- */
  function once(el, ev, ms) {
    return new Promise(res => {
      let done = false;
      const fin = ok => { if (done) return; done = true; el.removeEventListener(ev, h); el.removeEventListener('error', er); clearTimeout(to); res(ok); };
      const h = () => fin(true), er = () => fin(false);
      el.addEventListener(ev, h); el.addEventListener('error', er);
      const to = setTimeout(() => fin(false), ms);
    });
  }
  NS.extractFrames = async function (blob, n, width) {
    n = n || 8; width = width || 256;
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    try {
      if (!(await once(v, 'loadedmetadata', 9000))) return null;
      let dur = v.duration;
      if (!isFinite(dur) || dur <= 0) dur = 8;
      const aspect = (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9;
      const W = width, Hh = Math.max(16, Math.round(width / aspect));
      const frames = [];
      for (let k = 0; k < n; k++) {
        v.currentTime = Math.min(dur - 0.05, dur * (k + 0.5) / n);
        if (!(await once(v, 'seeked', 4000))) continue;
        const c = document.createElement('canvas'); c.width = W; c.height = Hh;
        c.getContext('2d').drawImage(v, 0, 0, W, Hh);
        const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter;
        frames.push(t);
      }
      return frames.length ? { frames, aspect, duration: dur } : null;
    } finally {
      v.removeAttribute('src'); v.load();
      URL.revokeObjectURL(url);
    }
  };
})();

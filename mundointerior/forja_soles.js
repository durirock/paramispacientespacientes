/* ==========================================================================
   FORJA ESTELAR · SOLES DE AUDIO
   Nebulosas audio-reactivas (herencia de Musicosmos pulsar10) para Mundo Interior.
   - 'mp3'   : sol nacido de un archivo de audio local
   - 'tagua' : nebulosa majestuosa de Radio Tagua Tagua (con corona solar)
   Three.js r128 por script-tag. Expone window.ForjaLib.AudioSun.

   Optimización respecto a pulsar10: PointsMaterial ignoraba los atributos
   'alpha' y 'size' por partícula, así que esos cálculos se eliminaron, y los
   colores objetivo se calculan una vez por cuadro (no por partícula).
   Mismo aspecto, una fracción del gasto de CPU.
   ========================================================================== */
(function () {
  'use strict';
  const NS = window.ForjaLib = window.ForjaLib || {};

  NS.TAGUA_URL = 'https://stream-165.zeno.fm/lsthmognp16uv';

  const PAL = {
    mp3: {
      base: [{ h: .80, s: .9, l: .60 }, { h: .52, s: .9, l: .55 }, { h: .95, s: .8, l: .65 },
             { h: .70, s: .85, l: .50 }, { h: .35, s: .7, l: .50 }, { h: .05, s: .9, l: .60 }],
      core: [{ h: 0, s: 0, l: .80 }, { h: .83, s: .9, l: .55 }, { h: .93, s: .9, l: .62 },
             { h: .50, s: .85, l: .60 }, { h: .10, s: .9, l: .53 }]
    },
    tagua: {
      base: [{ h: .95, s: .9, l: .65 }, { h: .85, s: .88, l: .60 }, { h: .50, s: .85, l: .60 },
             { h: 0, s: .9, l: .55 }, { h: .90, s: .8, l: .70 }],
      core: [{ h: .93, s: .95, l: .70 }, { h: 0, s: 1, l: .65 }, { h: .52, s: .9, l: .65 }]
    }
  };
  const CORONA = [{ h: .12, s: 1, l: .75 }, { h: .08, s: .9, l: .80 }, { h: 0, s: 0, l: .95 }];

  let _tex = null;
  function particleTexture() {
    if (_tex) return _tex;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 31);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    gr.addColorStop(0.85, 'rgba(255,255,255,0.25)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    _tex = new THREE.CanvasTexture(c);
    return _tex;
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const tmpC = new THREE.Color(), tmpC2 = new THREE.Color();

  class AudioSun {
    /**
     * @param {object} o  { scene, position:Vector3, kind:'mp3'|'tagua', ctx:AudioContext,
     *                      listener:THREE.AudioListener, config }
     */
    constructor(o) {
      this.kind = o.kind || 'mp3';
      this.majestic = this.kind === 'tagua';
      this.config = o.config;                       // objeto compartido (pulso, etc.)
      this.size = this.majestic ? 34 : 24;          // radio máximo de expansión
      this.radius = this.size;
      this.count = this.majestic ? 5200 : 3600;
      this.coreR = this.size * 0.15;
      this.coronaR = this.size * 0.35;
      this.vScale = this.size / 70;                 // escala de velocidades vs pulsar10

      this.anchor = o.position.clone();
      this.group = new THREE.Object3D();
      this.group.position.copy(this.anchor);
      this.position = this.group.position;
      o.scene.add(this.group);
      this.scene = o.scene;

      const r = () => Math.random();
      this.driftAmp = new THREE.Vector3(5 + r() * 8, 2 + r() * 4, 5 + r() * 8);
      this.driftPh = new THREE.Vector3(r() * 6.28, r() * 6.28, r() * 6.28);
      this.driftSp = new THREE.Vector3(0.02 + r() * 0.03, 0.015 + r() * 0.02, 0.02 + r() * 0.03);

      // --- cadena de audio
      this.ctx = o.ctx;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.wave = new Uint8Array(this.analyser.fftSize);
      this.bins = this.analyser.frequencyBinCount;
      this.el = new Audio();
      this.el.crossOrigin = 'anonymous';
      this.el.preload = 'auto';
      this.srcNode = null;
      this.positional = new THREE.PositionalAudio(o.listener);
      this.positional.setNodeSource(this.analyser);
      this.group.add(this.positional);
      this.playing = false;
      this.level = 0;

      // --- paletas
      const P = PAL[this.majestic ? 'tagua' : 'mp3'];
      this.base = P.base; this.core = P.core;
      this.bi = Math.floor(r() * this.base.length); this.bt = this.bi; this.bp = 1;
      this.ci = Math.floor(r() * this.core.length); this.ct = this.ci; this.cp = 1;
      this.coi = 0;
      this.lastBase = performance.now(); this.lastCore = this.lastBase; this.lastCorona = this.lastBase;

      // --- partículas
      const N = this.count;
      this.pos = new Float32Array(N * 3);
      this.col = new Float32Array(N * 3);
      this.vel = new Float32Array(N * 3);
      this.life = new Float32Array(N);
      this.lifeMax = new Float32Array(N);
      this.r0 = new Float32Array(N);
      this.type = new Uint8Array(N);              // 0 periferia · 1 núcleo · 2 trazador · 3 corona
      for (let i = 0; i < N; i++) this._spawn(i, false);

      this.geo = new THREE.BufferGeometry();
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
      this.mat = new THREE.PointsMaterial({
        map: particleTexture(), vertexColors: true, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
        size: this.size * 0.024, alphaTest: 0.02, fog: false
      });
      this.points = new THREE.Points(this.geo, this.mat);
      this.points.frustumCulled = false;
      this.spin = new THREE.Object3D();
      this.spin.add(this.points);
      this.group.add(this.spin);

      this.heart = new THREE.Mesh(
        new THREE.SphereGeometry(this.coreR * 0.25, 14, 10),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      );
      this.spin.add(this.heart);

      // objetivo invisible para tocar / orbitar
      this.hit = new THREE.Mesh(new THREE.SphereGeometry(this.size * 0.5, 12, 10),
        new THREE.MeshBasicMaterial({ visible: false }));
      this.group.add(this.hit);

      this.expansion = 1;
      this.frame = 0;
    }

    _spawn(i, forceCore) {
      const i3 = i * 3, rnd = Math.random;
      let r, t = 0;
      if (this.majestic && rnd() < 0.15) { t = 3; r = this.coreR * 0.8 + rnd() * (this.coronaR - this.coreR * 0.8); }
      else if (forceCore || rnd() < 0.10 + rnd() * 0.08) { t = 1; r = Math.pow(rnd(), 3) * this.coreR; }
      else {
        r = this.coreR + Math.pow(rnd(), 1.4) * (this.size * 0.8 - this.coreR);
        if (rnd() < 0.008) t = 2;
      }
      this.type[i] = t;
      this.r0[i] = r;
      const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
      const sx = Math.sin(ph) * Math.cos(th), sy = Math.sin(ph) * Math.sin(th), sz = Math.cos(ph);
      this.pos[i3] = r * sx; this.pos[i3 + 1] = r * sy; this.pos[i3 + 2] = r * sz;
      const hsl = t === 3 ? CORONA[this.coi % CORONA.length]
                : t === 1 ? this.core[this.ci % this.core.length]
                : this.base[this.bi % this.base.length];
      if (t === 2) tmpC.setHSL((hsl.h + 0.4) % 1, 0.08, 0.95);
      else tmpC.setHSL(hsl.h, hsl.s, hsl.l * (t === 3 ? 0.8 + rnd() * 0.4 : 1));
      this.col[i3] = tmpC.r; this.col[i3 + 1] = tmpC.g; this.col[i3 + 2] = tmpC.b;
      const sp = (t === 3 ? 0.005 + rnd() * 0.02 : 0.015 + rnd() * 0.08) * 0.015 * this.vScale;
      this.vel[i3] = sx * sp + (rnd() - 0.5) * 0.01 * this.vScale;
      this.vel[i3 + 1] = sy * sp + (rnd() - 0.5) * 0.01 * this.vScale;
      this.vel[i3 + 2] = sz * sp + (rnd() - 0.5) * 0.01 * this.vScale;
      const lm = t === 3 ? 15 + rnd() * 10 : 7 + rnd() * 15;
      this.life[i] = lm; this.lifeMax[i] = lm;
    }

    /* ---------------- audio ---------------- */
    setSource(url, loop) {
      this.el.loop = !!loop;
      this.el.src = url;
      this.el.load();
    }
    _ensureSource() {
      if (this.srcNode) return true;
      try {
        this.srcNode = this.ctx.createMediaElementSource(this.el);
        this.srcNode.connect(this.analyser);
        return true;
      } catch (e) { console.warn('[Forja] fuente de audio:', e); return false; }
    }
    async play() {
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) {} }
      this._ensureSource();
      await this.el.play();
      this.playing = true;
    }
    pause() {
      try { this.el.pause(); } catch (e) {}
      this.playing = false;
    }
    stopStream() {
      this.pause();
      this.el.removeAttribute('src');
      this.el.load();
    }
    /* el panner da dirección y la caída natural; setFade la lleva a cero en el borde del influjo */
    setPanner(ref, influence) {
      const p = this.positional.panner;
      if (!p) return;
      p.distanceModel = 'inverse';
      p.refDistance = ref;
      p.rolloffFactor = 0.6;
      p.maxDistance = Math.max(ref + 1, influence);
    }
    setVolume(v) { this.baseVol = v; this._applyGain(); }
    setFade(f) {
      if (this.fade !== undefined && Math.abs(f - this.fade) < 0.004) return;
      this.fade = f; this._applyGain();
    }
    _applyGain() {
      const v = (this.baseVol == null ? 1 : this.baseVol) * (this.fade == null ? 1 : this.fade);
      const g = this.positional.gain.gain;
      g.setTargetAtTime(v, this.ctx.currentTime, 0.08);
    }

    /* ---------------- vida ---------------- */
    update(t, dt, camPos) {
      this.frame++;
      // deriva lenta alrededor de su ancla
      this.position.set(
        this.anchor.x + Math.sin(t * this.driftSp.x + this.driftPh.x) * this.driftAmp.x,
        this.anchor.y + Math.cos(t * this.driftSp.y + this.driftPh.y) * this.driftAmp.y,
        this.anchor.z + Math.sin(t * this.driftSp.z + this.driftPh.z) * this.driftAmp.z
      );
      const dist = camPos ? camPos.distanceTo(this.position) : 0;

      if (!this.playing) {
        this.level *= 0.94;
        this.spin.rotation.y += 0.0012 * dt * 4;
        this.spin.rotation.x += 0.0007 * dt * 4;
        return;
      }
      // a lo lejos actualiza un cuadro de cada dos (ahorro energético)
      if (dist > 380 && (this.frame & 1)) return;
      const step = dist > 380 ? dt * 2 : dt;
      this._animate(step);
    }

    _animate(dt) {
      const cfg = this.config, A = this.analyser;
      A.getByteFrequencyData(this.freq);
      A.getByteTimeDomainData(this.wave);
      let sum = 0;
      for (let i = 0; i < this.wave.length; i++) sum += Math.abs(this.wave[i] - 128);
      const vol = Math.min(1, (sum / this.wave.length) / 40);
      const B = this.bins, F = this.freq;
      const bass = (F[Math.floor(B * .005)] + F[Math.floor(B * .025)]) / 510;
      const mids = (F[Math.floor(B * .12)] + F[Math.floor(B * .22)]) / 510;
      const highs = (F[Math.floor(B * .35)] + F[Math.floor(B * .50)]) / 510;
      this.level = vol;

      const now = performance.now();
      const rs = cfg.rotation / 0.0012;
      this.spin.rotation.x += 0.0007 * rs * dt * (0.08 + vol * 0.25) * 60;
      this.spin.rotation.y += 0.0012 * rs * dt * (0.08 + vol * 0.5) * 60;
      this.spin.rotation.z += 0.0005 * rs * dt * (0.08 + vol * 0.25) * 60;

      const pulseCycle = now * 0.001 * (0.5 + cfg.pulseSpeed * 50);
      const eased = (Math.sin(pulseCycle - Math.PI / 2) + 1) / 2 * vol;
      this.expansion = lerp(this.expansion, 0.2 + eased * cfg.pulse, cfg.pulseSpeed);

      // paletas en transición
      if (now - this.lastBase > 11000 + Math.random() * 2500) {
        this.bt = (this.bi + 1 + Math.floor(Math.random() * (this.base.length - 1))) % this.base.length;
        this.bp = 0; this.lastBase = now;
      }
      if (this.bp < 1) this.bp = Math.min(1, this.bp + dt * cfg.outerColorSpeed); else this.bi = this.bt;
      if (now - this.lastCore > 2500 + Math.random() * 800) {
        this.ct = (this.ci + 1) % this.core.length; this.cp = 0; this.lastCore = now;
      }
      if (this.cp < 1) this.cp = Math.min(1, this.cp + dt * cfg.coreColorSpeed); else this.ci = this.ct;
      if (this.majestic && now - this.lastCorona > 7000) { this.coi = (this.coi + 1) % CORONA.length; this.lastCorona = now; }

      // colores objetivo una vez por cuadro
      const b0 = this.base[this.bi], b1 = this.base[this.bt];
      const pr = { r: 0, g: 0, b: 0 };
      tmpC.setHSL(lerp(b0.h, b1.h, this.bp), lerp(b0.s, b1.s, this.bp),
        Math.min(0.70, lerp(b0.l, b1.l, this.bp) + vol * cfg.colorAudio * 0.8 + mids * cfg.colorAudio * 0.5));
      pr.r = tmpC.r; pr.g = tmpC.g; pr.b = tmpC.b;
      const c0 = this.core[this.ci], c1 = this.core[this.ct];
      tmpC.setHSL(lerp(c0.h, c1.h, this.cp), lerp(c0.s, c1.s, this.cp),
        Math.min(0.85 * cfg.coreBrightness, lerp(c0.l, c1.l, this.cp) + vol * cfg.colorAudio + bass * cfg.colorAudio * 0.8));
      const cr = { r: tmpC.r, g: tmpC.g, b: tmpC.b };
      tmpC2.setHSL(c0.h, c0.s * 0.7, Math.min(0.8 * cfg.coreBrightness, c0.l + vol * cfg.colorAudio * 0.4));
      const ci = { r: tmpC2.r, g: tmpC2.g, b: tmpC2.b };
      tmpC.setHSL((b0.h + 0.4) % 1, 0.05, 0.85);
      const tr = { r: tmpC.r, g: tmpC.g, b: tmpC.b };
      const co = CORONA[this.coi];
      tmpC.setHSL(co.h, co.s, co.l * (0.7 + vol * 0.5 + highs * 0.3));
      const crn = { r: tmpC.r, g: tmpC.g, b: tmpC.b };

      // corazón
      const hl = Math.min(0.8, c0.l * (0.3 + vol * 0.7) + bass * cfg.coreBrightness);
      this.heart.material.color.setHSL(c0.h, c0.s * 0.75, hl);
      this.heart.material.opacity = lerp(this.heart.material.opacity, 0.02 + bass * 0.2 + vol * 0.1, 0.035);
      const hs = 0.6 + vol + bass * 0.7;
      this.heart.scale.set(hs, hs, hs);

      const N = this.count, P = this.pos, C = this.col, Vv = this.vel, rnd = Math.random;
      const jitter = 0.006 * (1 + bass * 2.5) * this.vScale;
      const motion = dt * (1 + vol * 28);
      const infR = this.coreR * 4.5, infK = 0.08 + bass * 0.18;
      const forceP = vol > 0.05 ? vol * 0.45 : 0;
      for (let i = 0; i < N; i++) {
        const i3 = i * 3;
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this._spawn(i, forceP > 0 && rnd() < forceP); continue; }
        Vv[i3] += ((rnd() - 0.5) * jitter - Vv[i3]) * 0.035;
        Vv[i3 + 1] += ((rnd() - 0.5) * jitter - Vv[i3 + 1]) * 0.035;
        Vv[i3 + 2] += ((rnd() - 0.5) * jitter - Vv[i3 + 2]) * 0.035;
        let x = P[i3] + Vv[i3] * motion, y = P[i3 + 1] + Vv[i3 + 1] * motion, z = P[i3 + 2] + Vv[i3 + 2] * motion;
        const t = this.type[i];
        const d = Math.sqrt(x * x + y * y + z * z);
        if (d > 0.01) {
          const lim = t === 3 ? 1.1 : t === 1 ? 1 : t === 2 ? 0.95 : 0.88;
          const k = 1 + (this.r0[i] * this.expansion * lim / d - 1) * 0.018;
          x *= k; y *= k; z *= k;
        }
        P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
        let tr_, tg_, tb_;
        if (t === 3) { tr_ = crn.r; tg_ = crn.g; tb_ = crn.b; }
        else if (t === 2) { tr_ = tr.r; tg_ = tr.g; tb_ = tr.b; }
        else if (t === 1) { tr_ = cr.r; tg_ = cr.g; tb_ = cr.b; }
        else {
          const inf = Math.max(0, 1 - this.r0[i] / infR) * infK;
          tr_ = pr.r + (ci.r - pr.r) * inf; tg_ = pr.g + (ci.g - pr.g) * inf; tb_ = pr.b + (ci.b - pr.b) * inf;
        }
        C[i3] += (tr_ - C[i3]) * 0.028; C[i3 + 1] += (tg_ - C[i3 + 1]) * 0.028; C[i3 + 2] += (tb_ - C[i3 + 2]) * 0.028;
      }
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }

    dispose() {
      this.pause();
      try { this.el.removeAttribute('src'); this.el.load(); } catch (e) {}
      try { this.srcNode && this.srcNode.disconnect(); } catch (e) {}
      try { this.positional.disconnect(); } catch (e) {}
      this.scene.remove(this.group);
      this.geo.dispose(); this.mat.dispose();
      this.heart.geometry.dispose(); this.heart.material.dispose();
      this.hit.geometry.dispose();
    }
  }

  NS.AudioSun = AudioSun;
})();

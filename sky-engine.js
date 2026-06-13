/**
 * ═══════════════════════════════════════════════════════════════════
 *  VIGI-SKY SKYENGINE v1.2 — Moteur de planétarium 3D réutilisable
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Moteur canvas 2D avec projection 3D perspective de la sphère céleste.
 *  Aucune dépendance. Données : window.SKY (sky-data.js : 5044 étoiles
 *  Yale BSC/Hipparcos, 89 constellations, 17 objets du ciel profond).
 *
 *  USAGE MINIMAL :
 *    <canvas id="sky"></canvas>
 *    <script src="/sky-engine/sky-data.js"></script>
 *    <script src="/sky-engine/sky-engine.js"></script>
 *    <script>
 *      const eng = new SkyEngine(document.getElementById('sky'), SKY);
 *      eng.start();
 *    </script>
 *
 *  API PUBLIQUE :
 *    eng.start() / eng.stop()              — boucle de rendu
 *    eng.flyTo(ra, dec, fov, ms) → Promise — vol caméra animé (easing)
 *    eng.set('constellations'|'labels'|'dsos'|'milkyway'|'meteors'|'planets', bool)
 *    eng.addMarker({ra, dec, label, color, size, pulse}) → id
 *    eng.clearMarkers()                    — pour overlays custom (OVNI, radiants…)
 *    eng.addLayer(name, fn(ctx, eng))      — couche de rendu custom par frame
 *    eng.removeLayer(name)
 *    eng.project(ra, dec) → {x, y, visible} — projection pour tes layers
 *    eng.pick(x, y) → {type:'star'|'dso'|'marker', ...} | null
 *    eng.tour(stops, {onStep, onEnd})      — visite guidée cinématique
 *      stops: [{ra, dec, fov, title, text, holdMs}]
 *    eng.stopTour()
 *    eng.onSelect = (obj) => {}            — callback clic objet
 *    eng.searchIndex() → [{name, ra, dec, type, fov}] — pour autocomplete
 *
 *  Réutilisable pour : overlay observations OVNI (addMarker), radiants de
 *  météores, position de l'étoile de naissance, trajectoires satellites
 *  (addLayer), mini-cartes embarquées (canvas de n'importe quelle taille).
 * ═══════════════════════════════════════════════════════════════════
 */
class SkyEngine {
  constructor(canvas, data, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = data;
    this.o = Object.assign({
      constellations: true, labels: true, dsos: true,
      milkyway: true, meteors: true, conLabels: true, planets: true, conNameKey: 'n',
      bg: '#03030f'
    }, opts);
    this.cam = { yaw: 84, pitch: 10, fov: 70 };   // démarre sur Orion
    this.vel = { yaw: 0, pitch: 0 };
    this.markers = [];
    this.layers = new Map();
    this.onSelect = null;
    this._flight = null;
    this._tour = null;
    this._meteors = [];
    this._running = false;

    this._precompute();
    this._computePlanets();
    setInterval(() => this._computePlanets(), 120000);
    this._makeSprites();
    this._bindInput();
    this._resize();
    addEventListener('resize', () => this._resize());
  }

  /* ---------- précalculs ---------- */
  _precompute() {
    const S = this.data.stars, n = S.length;
    this.vec = new Float32Array(n * 3);
    const D = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const ra = S[i][0] * D, dec = S[i][1] * D, cd = Math.cos(dec);
      this.vec[i*3]   = cd * Math.cos(ra);
      this.vec[i*3+1] = cd * Math.sin(ra);
      this.vec[i*3+2] = Math.sin(dec);
    }
    // Voie lactée v1.1 : 3 bandes galactiques (b=-7,0,+7) + bulbe vers Sagittaire (l~0)
    this.mw = [];
    const ragp = 192.85948 * D, decgp = 27.12825 * D, lcp = 122.93192 * D;
    const galToEq = (l, b) => {
      const lr = l * D, br = b * D;
      const sinb = Math.sin(br), cosb = Math.cos(br);
      const sindec = sinb * Math.sin(decgp) + cosb * Math.cos(decgp) * Math.cos(lcp - lr);
      const dec = Math.asin(sindec);
      const y = cosb * Math.sin(lcp - lr);
      const x = sinb * Math.cos(decgp) - cosb * Math.sin(decgp) * Math.cos(lcp - lr);
      const ra = ragp + Math.atan2(y, x);
      return [(ra / D % 360 + 360) % 360, dec / D];
    };
    for (const b of [-7, 0, 7]) {
      for (let l = 0; l < 360; l += 5) {
        const [ra, dec] = galToEq(l, b);
        // intensité : bulbe vers le centre galactique (l proche de 0/360)
        const dl = Math.min(l, 360 - l);
        const w = b === 0 ? 1 : 0.45;
        const bulge = 1 + 1.1 * Math.exp(-dl * dl / 2200);
        this.mw.push([ra, dec, w * bulge]);
      }
    }
  }

  _starColor(bv) {
    if (bv < 0)    return '#9db4ff';
    if (bv < 0.3)  return '#cad8ff';
    if (bv < 0.6)  return '#f8f7ff';
    if (bv < 1.0)  return '#fff4e8';
    if (bv < 1.5)  return '#ffd9a6';
    return '#ffc66f';
  }

  _makeSprites() {
    // sprites pré-rendus : 5 couleurs × 6 tailles → drawImage ultra rapide
    this.sprites = {};
    const colors = ['#9db4ff', '#cad8ff', '#f8f7ff', '#fff4e8', '#ffd9a6', '#ffc66f'];
    for (const col of colors) {
      const arr = [];
      for (let s = 0; s < 7; s++) {
        const r = 1.2 + s * 1.5, pad = r * 3, size = Math.ceil(pad * 2);
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const x = c.getContext('2d');
        const g = x.createRadialGradient(pad, pad, 0, pad, pad, pad);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.25, col);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = g;
        x.fillRect(0, 0, size, size);
        arr.push(c);
      }
      this.sprites[col] = arr;
    }
    // blob voie lactée
    const m = document.createElement('canvas');
    m.width = m.height = 256;
    const mx = m.getContext('2d');
    const mg = mx.createRadialGradient(128, 128, 0, 128, 128, 128);
    mg.addColorStop(0, 'rgba(180,190,230,0.085)');
    mg.addColorStop(0.6, 'rgba(150,160,210,0.04)');
    mg.addColorStop(1, 'rgba(0,0,0,0)');
    mx.fillStyle = mg;
    mx.fillRect(0, 0, 256, 256);
    this.mwSprite = m;
  }

  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.cv.width = this.cv.clientWidth * dpr;
    this.cv.height = this.cv.clientHeight * dpr;
    this.dpr = dpr;
  }

  /* ---------- projection ---------- */
  _basis() {
    const D = Math.PI / 180;
    const y = this.cam.yaw * D, p = this.cam.pitch * D;
    const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
    // forward, right, up
    this.F = [cp * cy, cp * sy, sp];
    this.R = [-sy, cy, 0];
    this.U = [-sp * cy, -sp * sy, cp];
    this.fl = (this.cv.height / 2) / Math.tan(this.cam.fov * D / 2);
  }

  _proj(vx, vy, vz) {
    const z = vx * this.F[0] + vy * this.F[1] + vz * this.F[2];
    if (z < 0.02) return null;
    const x = vx * this.R[0] + vy * this.R[1] + vz * this.R[2];
    const yy = vx * this.U[0] + vy * this.U[1] + vz * this.U[2];
    return [this.cv.width / 2 + x * this.fl / z, this.cv.height / 2 - yy * this.fl / z, z];
  }

  /** Projection inverse v1.2 : point écran (px CSS) → coordonnées célestes {ra, dec}. */
  unproject(px, py) {
    this._basis();
    const x = (px * this.dpr - this.cv.width / 2) / this.fl;
    const y = (this.cv.height / 2 - py * this.dpr) / this.fl;
    // rayon caméra → monde : v = R*x + U*y + F*1 (normalisé)
    const vx = this.R[0] * x + this.U[0] * y + this.F[0];
    const vy = this.R[1] * x + this.U[1] * y + this.F[1];
    const vz = this.R[2] * x + this.U[2] * y + this.F[2];
    const n = Math.hypot(vx, vy, vz);
    const R2D = 180 / Math.PI;
    return {
      ra: ((Math.atan2(vy / n, vx / n) * R2D) % 360 + 360) % 360,
      dec: Math.asin(vz / n) * R2D
    };
  }

  /** Distance angulaire (degrés) entre deux points célestes. */
  static angularDist(ra1, dec1, ra2, dec2) {
    const D = Math.PI / 180;
    const a = Math.sin(dec1 * D) * Math.sin(dec2 * D) +
              Math.cos(dec1 * D) * Math.cos(dec2 * D) * Math.cos((ra1 - ra2) * D);
    return Math.acos(Math.max(-1, Math.min(1, a))) / D;
  }

  /** Projection publique RA/Dec (degrés) → écran. Pour les layers custom. */
  project(ra, dec) {
    const D = Math.PI / 180, r = ra * D, d = dec * D, cd = Math.cos(d);
    const p = this._proj(cd * Math.cos(r), cd * Math.sin(r), Math.sin(d));
    if (!p) return { x: 0, y: 0, visible: false };
    return { x: p[0] / this.dpr, y: p[1] / this.dpr, visible: p[0] >= 0 && p[0] <= this.cv.width && p[1] >= 0 && p[1] <= this.cv.height };
  }

  /* ---------- interaction ---------- */
  _bindInput() {
    const cv = this.cv;
    let drag = null, pinch0 = 0, moved = 0;
    const pos = e => e.touches ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY];

    const down = e => {
      if (e.touches && e.touches.length === 2) {
        pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        return;
      }
      drag = pos(e); moved = 0;
      this.vel.yaw = this.vel.pitch = 0;
      // v1.1.1 : un simple clic ne tue plus le vol/la visite — seul un vrai drag (voir move)
    };
    const move = e => {
      if (e.touches && e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this.cam.fov = Math.max(8, Math.min(110, this.cam.fov * pinch0 / d));
        pinch0 = d;
        e.preventDefault();
        return;
      }
      if (!drag) return;
      const p = pos(e);
      const k = this.cam.fov / (this.cv.clientHeight);
      const dy = (p[0] - drag[0]) * k, dp = (p[1] - drag[1]) * k;
      // v1.1.1 : vrai drag détecté -> on interrompt vol + visite proprement (promesse résolue, UI notifiée)
      if (moved === 0 && (Math.abs(dy) + Math.abs(dp)) > 0.15) { this._cancelFlight(); this.stopTour(); }
      this.cam.yaw = ((this.cam.yaw + dy) % 360 + 360) % 360;
      this.cam.pitch = Math.max(-89, Math.min(89, this.cam.pitch + dp));
      this.vel.yaw = dy; this.vel.pitch = dp;
      moved += Math.abs(dy) + Math.abs(dp);
      drag = p;
      e.preventDefault();
    };
    const up = e => {
      if (drag && moved < 0.5 && this.onSelect) {
        const r = cv.getBoundingClientRect();
        const px = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) - r.left;
        const py = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY) - r.top;
        const hit = this.pick(px, py);
        if (hit) this.onSelect(hit);
      }
      drag = null;
    };
    cv.addEventListener('mousedown', down);
    cv.addEventListener('mousemove', move);
    addEventListener('mouseup', up);
    cv.addEventListener('touchstart', down, { passive: false });
    cv.addEventListener('touchmove', move, { passive: false });
    cv.addEventListener('touchend', up);
    cv.addEventListener('wheel', e => {
      this.cam.fov = Math.max(8, Math.min(110, this.cam.fov * (e.deltaY > 0 ? 1.12 : 0.89)));
      e.preventDefault();
    }, { passive: false });
  }

  /** Trouve l'objet le plus proche d'un point écran (px CSS). */
  pick(px, py) {
    const x = px * this.dpr, y = py * this.dpr;
    let best = null, bd = 28 * this.dpr;
    const S = this.data.stars;
    for (let i = 0; i < S.length; i++) {
      if (S[i][2] > 5.2 && !this.data.names[i]) continue;
      const p = this._proj(this.vec[i*3], this.vec[i*3+1], this.vec[i*3+2]);
      if (!p) continue;
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < bd) { bd = d; best = { type: 'star', i, name: this.data.names[i] || null, ra: S[i][0], dec: S[i][1], mag: S[i][2], bv: S[i][3] }; }
    }
    if (this.o.dsos) for (const d of this.data.dsos) {
      const pr = this.project(d.ra, d.dec);
      if (pr.visible && Math.hypot(pr.x - px, pr.y - py) < 26) best = { type: 'dso', ...d };
    }
    for (const m of this.markers) {
      const pr = this.project(m.ra, m.dec);
      if (pr.visible && Math.hypot(pr.x - px, pr.y - py) < 26) best = { type: 'marker', ...m };
    }
    return best;
  }

  /* ---------- markers & layers (extensibilité) ---------- */
  addMarker(m) { const id = Date.now() + Math.random(); this.markers.push({ color: '#22d3ee', size: 10, pulse: true, ...m, _id: id }); return id; }
  clearMarkers() { this.markers = []; }
  addLayer(name, fn) { this.layers.set(name, fn); }
  removeLayer(name) { this.layers.delete(name); }
  set(k, v) { this.o[k] = v; }

  /* ---------- vol caméra ---------- */
  _cancelFlight() {
    if (this._flight) { const d = this._flight.done; this._flight = null; if (d) d(); }
  }

  flyTo(ra, dec, fov = 30, ms = 2200) {
    this._cancelFlight();   // v1.1.1 : jamais de promesse orpheline
    return new Promise(res => {
      let dy = ra - this.cam.yaw;
      if (dy > 180) dy -= 360;
      if (dy < -180) dy += 360;
      this._flight = {
        t0: performance.now(), ms,
        y0: this.cam.yaw, p0: this.cam.pitch, f0: this.cam.fov,
        dy, dp: dec - this.cam.pitch, df: fov - this.cam.fov,
        done: res
      };
    });
  }

  /* ---------- visite guidée ---------- */
  tour(stops, opts = {}) {
    this.stopTour();
    this._tour = { stops, i: 0, opts, alive: true };
    const step = async () => {
      const T = this._tour;
      if (!T || !T.alive || T.i >= stops.length) {
        if (opts.onEnd) opts.onEnd();
        this._tour = null;
        return;
      }
      const s = stops[T.i];
      if (opts.onStep) opts.onStep(s, T.i);
      await this.flyTo(s.ra, s.dec, s.fov || 25, s.flyMs || 2600);
      if (!T.alive) return;
      setTimeout(() => { if (T.alive) { T.i++; step(); } }, s.holdMs || 4200);
    };
    step();
  }
  stopTour() {
    if (this._tour) {
      this._tour.alive = false;
      const cb = this._tour.opts && this._tour.opts.onAbort;
      this._tour = null;
      if (cb) cb();   // v1.1.1 : l UI peut se nettoyer (carte, bouton, audio)
    }
  }

  /** Index pour autocomplete recherche. */
  searchIndex() {
    const out = [];
    const S = this.data.stars;
    for (const [i, n] of Object.entries(this.data.names)) out.push({ name: n, ra: S[i][0], dec: S[i][1], type: 'étoile', fov: 25 });
    for (const [id, c] of Object.entries(this.data.connames)) out.push({ name: c[this.o.conNameKey] || c.n, ra: c.ra, dec: c.dec, type: 'constellation', fov: 55 });
    for (const d of this.data.dsos) out.push({ name: d.n, ra: d.ra, dec: d.dec, type: d.t, fov: 18 });
    return out;
  }

  /* ---------- boucle de rendu ---------- */
  start() { if (!this._running) { this._running = true; this._loop(); } }
  stop() { this._running = false; }

  _loop() {
    if (!this._running) return;
    const now = performance.now();

    // vol en cours
    if (this._flight) {
      const F = this._flight, t = Math.min(1, (now - F.t0) / F.ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
      this.cam.yaw = ((F.y0 + F.dy * e) % 360 + 360) % 360;
      this.cam.pitch = F.p0 + F.dp * e;
      this.cam.fov = F.f0 + F.df * e;
      if (t >= 1) { const d = F.done; this._flight = null; d(); }
    } else {
      // inertie
      this.cam.yaw = ((this.cam.yaw + this.vel.yaw) % 360 + 360) % 360;
      this.cam.pitch = Math.max(-89, Math.min(89, this.cam.pitch + this.vel.pitch));
      this.vel.yaw *= 0.94; this.vel.pitch *= 0.94;
    }

    this._render(now);
    requestAnimationFrame(() => this._loop());
  }

  _render(now) {
    const ctx = this.ctx, W = this.cv.width, H = this.cv.height;
    this._basis();

    // fond
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#04041a'); bg.addColorStop(0.5, this.o.bg); bg.addColorStop(1, '#070718');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // voie lactée (v1.1 : 3 bandes + bulbe central pondéré)
    if (this.o.milkyway) {
      const sc = H / 700;
      for (const [ra, dec, w] of this.mw) {
        const D = Math.PI / 180, r = ra * D, d = dec * D, cd = Math.cos(d);
        const p = this._proj(cd * Math.cos(r), cd * Math.sin(r), Math.sin(d));
        if (!p) continue;
        const size = (300 + 140 * Math.sin(ra * 0.05)) * sc * (70 / this.cam.fov) * (w || 1);
        ctx.globalAlpha = Math.min(1, 0.55 * (w || 1));
        ctx.drawImage(this.mwSprite, p[0] - size / 2, p[1] - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    }

    // lignes constellations
    if (this.o.constellations) {
      ctx.strokeStyle = 'rgba(140,120,230,0.34)';
      ctx.lineWidth = Math.max(1, this.dpr * 0.8);
      const D = Math.PI / 180;
      for (const con of this.data.conlines) {
        for (const line of con.l) {
          let prev = null;
          for (const [ra, dec] of line) {
            const r = ra * D, d = dec * D, cd = Math.cos(d);
            const p = this._proj(cd * Math.cos(r), cd * Math.sin(r), Math.sin(d));
            if (p && prev) {
              ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
            }
            prev = p;
          }
        }
      }
      // noms de constellations
      if (this.o.conLabels && this.cam.fov > 28) {
        ctx.fillStyle = 'rgba(167,150,240,0.5)';
        ctx.font = `500 ${Math.round(11 * this.dpr)}px 'Space Grotesk', sans-serif`;
        ctx.textAlign = 'center';
        for (const c of Object.values(this.data.connames)) {
          const p = this.project(c.ra, c.dec);
          if (p.visible) ctx.fillText((c[this.o.conNameKey] || c.n).toUpperCase(), p.x * this.dpr, p.y * this.dpr);
        }
      }
    }

    // étoiles (sprites par buckets)
    const S = this.data.stars;
    const zoomBoost = Math.sqrt(70 / this.cam.fov);
    for (let i = 0; i < S.length; i++) {
      const p = this._proj(this.vec[i*3], this.vec[i*3+1], this.vec[i*3+2]);
      if (!p || p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) continue;
      const mag = S[i][2];
      const col = this._starColor(S[i][3]);
      if (mag < 4.6) {
        const bucket = Math.max(0, Math.min(6, Math.round((4.6 - mag) * 1.15)));
        const sp = this.sprites[col][bucket];
        let sz = sp.width * 0.55 * zoomBoost * this.dpr / 2;
        // v1.1 : scintillement subtil des étoiles brillantes
        if (mag < 1.5) {
          const tw = 0.92 + 0.08 * Math.sin(now / 130 + i * 1.7);
          sz *= tw;
          ctx.globalAlpha = 0.85 + 0.15 * Math.sin(now / 170 + i * 2.3);
        }
        ctx.drawImage(sp, p[0] - sz / 2, p[1] - sz / 2, sz, sz);
        ctx.globalAlpha = 1;
        // v1.1 : aigrettes de diffraction sur les plus brillantes
        if (mag < 0.5) {
          const L = sz * 0.9;
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.4 + 0.12 * Math.sin(now / 150 + i);
          ctx.lineWidth = this.dpr * 0.7;
          ctx.beginPath();
          ctx.moveTo(p[0] - L, p[1]); ctx.lineTo(p[0] + L, p[1]);
          ctx.moveTo(p[0], p[1] - L); ctx.lineTo(p[0], p[1] + L);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      } else {
        ctx.globalAlpha = Math.max(0.15, 1 - (mag - 4.6) * 0.55);
        ctx.fillStyle = col;
        ctx.fillRect(p[0], p[1], this.dpr, this.dpr);
        ctx.globalAlpha = 1;
      }
    }

    // noms d'étoiles brillantes
    if (this.o.labels) {
      const maxMag = this.cam.fov > 60 ? 1.4 : this.cam.fov > 35 ? 2.4 : 6.5;
      ctx.fillStyle = 'rgba(230,238,255,0.85)';
      ctx.font = `${Math.round(11 * this.dpr)}px Inter, sans-serif`;
      ctx.textAlign = 'left';
      for (const [i, n] of Object.entries(this.data.names)) {
        if (S[i][2] > maxMag) continue;
        const p = this._proj(this.vec[i*3], this.vec[i*3+1], this.vec[i*3+2]);
        if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
        ctx.fillText(n, p[0] + 8 * this.dpr, p[1] - 6 * this.dpr);
      }
    }

    // objets du ciel profond
    if (this.o.dsos) {
      ctx.textAlign = 'left';
      for (const d of this.data.dsos) {
        const D = Math.PI / 180, r = d.ra * D, dd = d.dec * D, cd = Math.cos(dd);
        const p = this._proj(cd * Math.cos(r), cd * Math.sin(r), Math.sin(dd));
        if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
        const col = d.t === 'galaxie' ? '#f0a6ff' : d.t === 'nébuleuse' ? '#7ee8a2' : '#7ec8ff';
        ctx.strokeStyle = col; ctx.lineWidth = this.dpr;
        ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.arc(p[0], p[1], 7 * this.dpr, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.arc(p[0], p[1], 2.5 * this.dpr, 0, 7); ctx.stroke();
        if (this.cam.fov < 75) {
          ctx.fillStyle = col;
          ctx.font = `${Math.round(10.5 * this.dpr)}px Inter, sans-serif`;
          ctx.fillText(d.n, p[0] + 11 * this.dpr, p[1] + 3 * this.dpr);
        }
        ctx.globalAlpha = 1;
      }
    }

    // markers custom (OVNI, radiants, étoile de naissance…)
    for (const m of this.markers) {
      const pr = this.project(m.ra, m.dec);
      if (!pr.visible) continue;
      const x = pr.x * this.dpr, y = pr.y * this.dpr;
      const puls = m.pulse ? 1 + 0.25 * Math.sin(now / 300) : 1;
      ctx.strokeStyle = m.color; ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath(); ctx.arc(x, y, m.size * this.dpr * puls, 0, 7); ctx.stroke();
      if (m.label) {
        ctx.fillStyle = m.color;
        ctx.font = `600 ${Math.round(11 * this.dpr)}px Inter, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(m.label, x + (m.size + 6) * this.dpr, y + 4 * this.dpr);
      }
    }

    // étoiles filantes
    if (this.o.meteors) {
      if (Math.random() < 0.006 && this._meteors.length < 2) {
        const a = Math.random() * Math.PI * 2;
        this._meteors.push({ x: Math.random() * W, y: Math.random() * H * 0.6, dx: Math.cos(a) * 14, dy: Math.sin(a) * 14 + 6, life: 1 });
      }
      for (const m of this._meteors) {
        const g = ctx.createLinearGradient(m.x, m.y, m.x - m.dx * 5, m.y - m.dy * 5);
        g.addColorStop(0, `rgba(255,255,255,${m.life})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 1.6 * this.dpr;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.dx * 5, m.y - m.dy * 5); ctx.stroke();
        m.x += m.dx; m.y += m.dy; m.life -= 0.025;
      }
      this._meteors = this._meteors.filter(m => m.life > 0);
    }

    // planètes v1.1
    if (this.o.planets) this._renderPlanets(ctx, now);

    // layers custom
    for (const fn of this.layers.values()) fn(ctx, this);
  }

  /* ---------- planètes v1.1 (algorithme Paul Schlyter, précision ~1°) ---------- */
  _computePlanets() {
    const now = new Date();
    const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1, dd = now.getUTCDate();
    const h = now.getUTCHours() + now.getUTCMinutes() / 60;
    const d = 367 * y - Math.floor(7 * (y + Math.floor((m + 9) / 12)) / 4) + Math.floor(275 * m / 9) + dd - 730530 + h / 24;
    const D = Math.PI / 180, R = 180 / Math.PI;
    const rev = a => ((a % 360) + 360) % 360;
    const ecl = (23.4393 - 3.563e-7 * d) * D;

    const kepler = (M, e) => {
      let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
      for (let k = 0; k < 5; k++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      return E;
    };
    const helio = (N, i, w, a, e, M) => {
      const E = kepler(M, e);
      const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
      const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
      const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(i));
      const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(i));
      const zh = r * (Math.sin(v + w) * Math.sin(i));
      return [xh, yh, zh, r, v];
    };

    // Soleil
    const ws = rev(282.9404 + 4.70935e-5 * d) * D, es = 0.016709 - 1.151e-9 * d, Ms = rev(356.0470 + 0.9856002585 * d) * D;
    const Es = kepler(Ms, es);
    const xvs = Math.cos(Es) - es, yvs = Math.sqrt(1 - es * es) * Math.sin(Es);
    const vs = Math.atan2(yvs, xvs), rs = Math.hypot(xvs, yvs);
    const lonsun = vs + ws;
    const xs = rs * Math.cos(lonsun), ys = rs * Math.sin(lonsun);

    const toRaDec = (xg, yg, zg) => {
      const xe = xg, ye = yg * Math.cos(ecl) - zg * Math.sin(ecl), ze = yg * Math.sin(ecl) + zg * Math.cos(ecl);
      return [rev(Math.atan2(ye, xe) * R), Math.atan2(ze, Math.hypot(xe, ye)) * R];
    };

    const P = [];
    // Soleil
    { const [ra, dec] = toRaDec(xs, ys, 0); P.push({ n: 'Soleil', ra, dec, color: '#fff7d6', size: 13, sym: '☉' }); }
    // Lune (géocentrique)
    {
      const N = rev(125.1228 - 0.0529538083 * d) * D, i = 5.1454 * D, w = rev(318.0634 + 0.1643573223 * d) * D;
      const a = 60.2666, e = 0.054900, M = rev(115.3654 + 13.0649929509 * d) * D;
      const [xh, yh, zh] = helio(N, i, w, a, e, M);
      const [ra, dec] = toRaDec(xh, yh, zh);
      P.push({ n: 'Lune', ra, dec, color: '#e8eaf0', size: 12, sym: '☾' });
    }
    // Planètes (éléments Schlyter)
    const EL = [
      ['Mercure', 48.3313 + 3.24587e-5 * d, 7.0047 + 5e-8 * d, 29.1241 + 1.01444e-5 * d, 0.387098, 0.205635 + 5.59e-10 * d, 168.6562 + 4.0923344368 * d, '#cdb89e', 5, '☿'],
      ['Vénus',   76.6799 + 2.46590e-5 * d, 3.3946 + 2.75e-8 * d, 54.8910 + 1.38374e-5 * d, 0.723330, 0.006773 - 1.302e-9 * d, 48.0052 + 1.6021302244 * d, '#f5e9c9', 9, '♀'],
      ['Mars',   49.5574 + 2.11081e-5 * d, 1.8497 - 1.78e-8 * d, 286.5016 + 2.92961e-5 * d, 1.523688, 0.093405 + 2.516e-9 * d, 18.6021 + 0.5240207766 * d, '#ff9466', 7, '♂'],
      ['Jupiter', 100.4542 + 2.76854e-5 * d, 1.3030 - 1.557e-7 * d, 273.8777 + 1.64505e-5 * d, 5.20256, 0.048498 + 4.469e-9 * d, 19.8950 + 0.0830853001 * d, '#f0d9b5', 10, '♃'],
      ['Saturne', 113.6634 + 2.38980e-5 * d, 2.4886 - 1.081e-7 * d, 339.3939 + 2.97661e-5 * d, 9.55475, 0.055546 - 9.499e-9 * d, 316.9670 + 0.0334442282 * d, '#e8d3a3', 9, '♄'],
    ];
    for (const [n, Nd, id_, wd, a, e, Md, color, size, sym] of EL) {
      const [xh, yh, zh] = helio(rev(Nd) * D, id_ * D, rev(wd) * D, a, e, rev(Md) * D);
      const [ra, dec] = toRaDec(xh + xs, yh + ys, zh);  // héliocentrique → géocentrique
      P.push({ n, ra, dec, color, size, sym });
    }
    this.planetPos = P;
  }

  _renderPlanets(ctx, now) {
    if (!this.planetPos) return;
    for (const pl of this.planetPos) {
      const pr = this.project(pl.ra, pl.dec);
      if (!pr.visible) continue;
      const x = pr.x * this.dpr, y = pr.y * this.dpr;
      const sz = pl.size * this.dpr * Math.sqrt(70 / this.cam.fov) * 0.55;
      const g = ctx.createRadialGradient(x, y, 0, x, y, sz * 2.2);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.3, pl.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, sz * 2.2, 0, 7); ctx.fill();
      if (this.cam.fov < 90) {
        ctx.fillStyle = pl.color;
        ctx.font = `600 ${Math.round(11 * this.dpr)}px Inter, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(pl.sym + ' ' + pl.n, x + sz * 2 + 4 * this.dpr, y + 4 * this.dpr);
      }
    }
  }
}
SkyEngine.VERSION = '1.2.1';
if (typeof module !== 'undefined') module.exports = SkyEngine;

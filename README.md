# SkyEngine

A dependency-free 3D planetarium engine in native canvas 2D. **Zero dependencies.** ~27 KB of JavaScript + 150 KB of real star data.

Renders a celestial sphere with perspective 3D projection: **5,044 real stars** (Yale Bright Star Catalogue + Hipparcos/Gaia), 89 constellations with FR/EN names, 17 Messier/NGC deep-sky objects, the real-time positions of the Sun, Moon and naked-eye planets, and a procedural Milky Way. Mouse/touch drag with inertia, wheel/pinch zoom, animated fly-to, custom markers and render layers.

🔭 **Live demo:** it powers the planetarium at [vigi-sky.fr/planetarium-3d.html](https://vigi-sky.fr/planetarium-3d.html)

```html
<canvas id="sky" style="position:fixed;inset:0;width:100%;height:100%"></canvas>
<script src="sky-data.js"></script>
<script src="sky-engine.js"></script>
<script>
  const eng = new SkyEngine(document.getElementById('sky'), SKY);
  eng.start();
</script>
```

That's it — open `demo.html` in any browser to see it run.

## Why

Most web planetariums pull in three.js, WebGL shaders, or a tiling server. SkyEngine is a single class over the 2D canvas: it precomputes unit vectors for every star (`Float32Array`), projects them through a camera basis each frame, and draws pre-rendered star sprites. It hits 60 fps on mobile, ships in two `<script>` tags, and has no build step. Drop it into any page.

## Files

| File | Role | Size |
|------|------|------|
| `sky-engine.js` | The engine (class `SkyEngine`) | 27 KB |
| `sky-data.js` | Data (`const SKY`): 5,044 stars (RA/Dec/mag/B-V), 493 proper names, 89 constellations with FR+EN names, 17 Messier/NGC DSOs | 150 KB |

Star data derived from the open-source [d3-celestial](https://github.com/ofrohn/d3-celestial) project (BSD licence), itself built on the Yale Bright Star and Hipparcos/Gaia (ESA) catalogues.

## API

### Camera
```js
eng.cam                                   // {yaw: RA°, pitch: Dec°, fov: °}
await eng.flyTo(ra, dec, fov, durMs)      // animated easeInOutCubic flight, shortest path
```

### Options (live toggles)
```js
eng.set('constellations', bool)  // lines + names (FR or EN)
eng.set('labels', bool)          // star names (auto density by FOV)
eng.set('dsos', bool)            // deep-sky objects
eng.set('milkyway', bool)        // procedural Milky Way band
eng.set('meteors', bool)         // random shooting stars
eng.set('planets', bool)         // Sun/Moon/planets at today's positions
```

### Object selection
```js
eng.onSelect = obj => { ... }    // click/tap. obj = {type:'star'|'dso'|'marker', name, ra, dec, mag, bv, ...}
eng.pick(x, y)                   // manual hit-test (CSS px)
```

### Extensibility — the key part
```js
// 1. Markers: custom points (sightings, meteor radiants, a birth star…)
const id = eng.addMarker({ra: 88.8, dec: 7.4, label: 'Marker #42', color: '#ef4444', size: 12, pulse: true});
eng.clearMarkers();

// 2. Layers: custom per-frame rendering (satellite tracks, heatmaps, lines…)
eng.addLayer('iss-track', (ctx, eng) => {
  const p = eng.project(issRa, issDec);          // project RA/Dec → screen
  if (p.visible) { /* draw on ctx — note: device coords = ×eng.dpr */ }
});
eng.removeLayer('iss-track');
```

### Cinematic guided tour
```js
eng.tour([
  {ra: 83.8, dec: -5.4, fov: 16, title: 'M42', text: '…', holdMs: 5000, flyMs: 2600},
  ...
], {
  onStep: (stop, i) => { /* render your narrative card */ },
  onEnd:  () => { ... }
});
eng.stopTour();   // also called automatically when the user drags
```

### Search
```js
eng.searchIndex()  // → [{name, ra, dec, type, fov}] (~600 entries)
// filter in your UI, then eng.flyTo(it.ra, it.dec, it.fov)
```

### Inverse projection (screen → sky)
```js
eng.unproject(px, py)                         // → {ra, dec}  (0.00° roundtrip)
SkyEngine.angularDist(ra1, dec1, ra2, dec2)   // static → angular distance in degrees
```

### Horizon view (alt/az) — *new in v1.3*
Switch from the equatorial star-map to **the sky as you actually see it** from a given place and time: real horizon line, N/E/S/W cardinal points, and stars below the ground are hidden. Drag becomes azimuth/altitude.

```js
eng.setHorizon(lat, lon, date)   // e.g. (48.8566, 2.3522, new Date())
eng.lookAtAltAz(azDeg, altDeg)   // azimuth from North through East, altitude above horizon
eng.setDate(date)                // change the moment — drives a time slider
eng.setEquatorial()              // back to the classic RA/Dec map
```

It only rotates the 3-vector camera basis into the observer's frame, so the 5,044-star render path is untouched — **zero per-frame cost**. `unproject()` still returns RA/Dec, so click-to-report keeps working in horizon mode.

## Options at construction

```js
new SkyEngine(canvas, SKY, {
  conNameKey: 'e',    // 'n' = native/FR names (default), 'e' = English constellation names
  planets: true,      // show Sun/Moon/planets
});
```

## Recipe ideas

1. **Sighting overlay** — `addMarker()` for each report in your database at its celestial position
2. **Meteor-shower radiants** — markers for Perseids/Geminids/Quadrantids with peak dates
3. **"Your birth star"** — `flyTo()` toward a star with a pulsing gold marker
4. **Live ISS / satellite track** — a layer fed by TLE data (convert lat/lon → RA/Dec)
5. **Cardboard VR mode** — two side-by-side renders (the engine takes any canvas)
6. **Constellation quiz** — hide names, `pick()` to check answers
7. **Precession time-lapse** — animate the celestial pole position

## Technical notes

- **Projection**: RA/Dec → precomputed unit vectors (`Float32Array`) → camera basis (forward/right/up) → perspective projection. Culling at z<0.02.
- **Performance**: pre-rendered star sprites (6 colours × 7 sizes, keyed by B-V) drawn via `drawImage`; stars fainter than mag 4.6 batched as `fillRect`. 60 fps on mobile.
- **Stellar colours**: B-V < 0 blue → > 1.5 red-orange (6 classes).
- **Planets**: Sun, Moon, Mercury–Saturn at today's positions via Paul Schlyter's algorithm (~1° accuracy), recomputed every 2 min.
- **Milky Way**: galactic equator converted to equatorial (J2000 rotation), soft radial blobs.
- **Inertia**: velocity preserved on release, friction 0.94/frame.

## Gotchas

- Custom-layer coordinates are in **device pixels** — multiply by `eng.dpr`.
- `project()` returns `visible:false` behind the camera — always test before drawing.

## Licence

MIT © 2026 — see [LICENSE](LICENSE). Star data under BSD (d3-celestial).

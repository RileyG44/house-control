// The real sky over the house (docs/landscape-weather.md): the sun and the moon where they
// really are, the weather the hub reads (clouds, fog, drizzle, rain, snow, storms), and the
// stage's lighting that follows them. Only for a plan with a `site`; without one the stage
// keeps its light and dark looks (world.js).
//
// The camera looks down on the model, so the sky itself is rarely in view: it shows in the
// light, in the lake (which reflects it, clouds and stars included), in cloud shadows on the
// ground, in the falling rain or snow, and in a dome behind everything on an opaque stage.
import * as THREE from 'three';
import { sunPosition, moonPosition, planDirection, daylight } from '../sky/sun.js';
import { weather } from '../sky/weather.js';

const SUN_EVERY = 30;        // seconds between sun and moon positions (they move ~0.1° a minute)
const EASE = 1.6;            // how fast the look follows a change (1/s)
const AMBIENT_FPS = 20;      // drifting clouds, ripples, the field in the wind
const WEATHER_FPS = 30;      // rain, snow, lightning
const VOLUME = 32;           // metres across the box rain and snow fall in, around the house
const VOLUME_H = 15;         // (below the camera, so nothing falls right in front of the lens)
const DOME = 2200;           // radius of the sky dome (inside the camera's far plane)
const MIN_SUN = 20;          // the light never comes in lower than this (the rooms stay readable)
const MIN_MOON = 30;

// When nothing is known about the weather: a plain, partly cloudy day or night.
const PLAIN = { kind: 'partly', code: 2, cloud: 35, precip: 0, snow: 0, wind: 9, windDir: 225, visibility: 24000, snowDepth: 0 };
// How much each kind darkens the day, beyond its clouds.
const GLOOM = { storm: 0.8, rain: 0.34, drizzle: 0.24, snow: 0.16, fog: 0.26, overcast: 0.12 };

const C = (hex) => new THREE.Color(hex);
const PAL = {
  dayZenith: C('#3b74c9'), dayHorizon: C('#b9d3ec'),
  greyZenith: C('#8c96a1'), greyHorizon: C('#b7bec5'),
  stormZenith: C('#3c434c'), stormHorizon: C('#646c74'),
  nightZenith: C('#050916'), nightHorizon: C('#121a2e'),
  nightGreyZenith: C('#0b0d12'), nightGreyHorizon: C('#1c1d22'),
  twZenith: C('#2c3d76'), twHorizon: C('#e8995e'), twGlow: C('#ff8c3a'),
  fogDay: C('#c3c8cc'), fogNight: C('#22252b'),
  cloudDay: C('#f4f6f8'), cloudGrey: C('#9aa3ac'), cloudNight: C('#1b1f28'), cloudDusk: C('#e7a37c'),
  // The stage: today's dark look by night, its light look by a clear day.
  hemiNight: C('#8ea6ff'), hemiDay: C('#fff4e6'), hemiGrey: C('#e4e9ee'), hemiDusk: C('#ffc196'), icy: C('#9fb3c8'),
  groundNight: C('#0b0e17'), groundDay: C('#8f9172'), groundSnow: C('#dfe4ea'),
  moonLight: C('#a9c0ff'), sunNoon: C('#fff0dc'), sunLow: C('#ffa45e'),
  rain: C('#c9d4e4'), snow: C('#ffffff'),
};

/* ---------- a tileable noise texture, shared by clouds, ripples and the ground ---------- */

let noise = null;
function noiseTexture() {
  if (noise) return noise;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  // Periodic value noise, several octaves, one fbm per channel.
  const lattice = (seed, cells) => {
    const r = [];
    let s = seed;
    for (let i = 0; i < cells * cells; i++) { s = (s * 16807) % 2147483647; r.push(s / 2147483647); }
    return (x, y) => r[((y % cells + cells) % cells) * cells + ((x % cells + cells) % cells)];
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const fbm = (seed, base, octaves) => {
    const out = new Float32Array(N * N);
    for (let o = 0; o < octaves; o++) {
      const cells = base << o;
      const at = lattice(seed + o * 101, cells);
      const amp = 0.5 ** o;
      for (let y = 0; y < N; y++) {
        const fy = (y / N) * cells;
        const y0 = Math.floor(fy);
        const ty = smooth(fy - y0);
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * cells;
          const x0 = Math.floor(fx);
          const tx = smooth(fx - x0);
          const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
          const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
          out[y * N + x] += (a + (b - a) * ty) * amp;
        }
      }
    }
    // Evened out, so a cloud cover of 40 % covers about 40 % of the sky.
    const order = [...out.keys()].sort((p, q) => out[p] - out[q]);
    const even = new Float32Array(N * N);
    order.forEach((i, rank) => { even[i] = rank / (N * N - 1); });
    return even;
  };
  const r = fbm(17, 4, 5);
  const g = fbm(4711, 8, 4);
  const b = fbm(90210, 16, 3);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = r[i] * 255;
    data[i * 4 + 1] = g[i] * 255;
    data[i * 4 + 2] = b[i] * 255;
    data[i * 4 + 3] = 255;
  }
  noise = new THREE.DataTexture(data, N, N);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.magFilter = THREE.LinearFilter;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.generateMipmaps = true;
  noise.needsUpdate = true;
  return noise;
}

// Shared by the dome, the lake, the ground and the weather: the sky's colour in a direction,
// the clouds, and the fog that thickens with the distance from the house (not from the camera,
// so the model itself stays clear).
export const SKY_GLSL = /* glsl */`
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uMoonLight;
uniform float uStars;
uniform float uCover;
uniform vec2 uCloudShift;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
uniform float uCloudShade;
uniform float uFlash;
uniform vec3 uFogColor;
uniform vec3 uFog;
uniform vec4 uHouse;
uniform vec2 uFade;
uniform vec3 uWind;
uniform float uWet;
uniform float uSnowCover;
uniform float uFrost;
uniform float uRain;
uniform vec3 uBolt;

float houseDist(vec3 p) {
  vec2 d = max(vec2(uHouse.x - p.x, uHouse.y - p.z), vec2(p.x - uHouse.z, p.z - uHouse.w));
  return length(max(d, 0.0));
}

float cloudDensity(vec2 xz, float scale) {
  float n = texture2D(uNoise, (xz + uCloudShift) / scale).r * 0.78
    + texture2D(uNoise, (xz + uCloudShift * 1.25) / (scale * 0.31) + 0.37).g * 0.22;
  float edge = mix(1.15, -0.2, uCover);
  return smoothstep(edge - 0.16, edge + 0.16, n);
}

vec3 skyColor(vec3 dir) {
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(up, 0.55));
  vec2 flatDir = normalize(dir.xz + 1e-5);
  vec2 sunFlat = normalize(uSunDir.xz + 1e-5);
  c += uGlow * pow(dot(flatDir, sunFlat) * 0.5 + 0.5, 3.0) * pow(1.0 - up, 3.0);
  float s = max(dot(dir, uSunDir), 0.0);
  c += uSunColor * (smoothstep(0.99955, 0.99975, s) * 9.0 + pow(s, 28.0) * 0.4);
  float m = max(dot(dir, uMoonDir), 0.0);
  c += vec3(0.86, 0.9, 1.0) * uMoonLight * (smoothstep(0.99965, 0.9998, m) * 3.0 + pow(m, 90.0) * 0.18);
  if (uStars > 0.001) {
    vec3 q = dir * 210.0;
    vec3 cell = floor(q);
    float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float star = step(0.9962, h) * smoothstep(0.4, 0.05, length(fract(q) - 0.5)) * (0.4 + (h - 0.9962) / 0.0038);
    c += vec3(0.9, 0.93, 1.0) * star * uStars * smoothstep(0.02, 0.3, up) * 1.4;
  }
  if (uCover > 0.001 && dir.y > 0.0) {
    // A layer 1.5 km up, curving down to the horizon (so it never stretches into streaks).
    vec2 at = dir.xz / (dir.y + 0.12) * 1500.0;
    float d = cloudDensity(at, 9000.0) * smoothstep(0.0, 0.08, dir.y);
    c = mix(c, mix(uCloudLit, uCloudDark, d * uCloudShade), d);
  }
  // A lightning bolt: a jagged line from the clouds down to the horizon.
  if (uBolt.y > 0.0 && dir.y > -0.01) {
    float el = asin(clamp(dir.y, 0.0, 1.0));
    float wob = (texture2D(uNoise, vec2(el * 2.5, uBolt.z)).g - 0.5) * 0.16
      + (texture2D(uNoise, vec2(el * 9.0, uBolt.z + 0.5)).b - 0.5) * 0.05;
    float off = abs(mod(atan(dir.x, dir.z) - uBolt.x - wob + 3.14159, 6.28318) - 3.14159);
    float reach = step(el, 0.9);
    c += vec3(0.85, 0.87, 1.0) * uBolt.y * reach * (smoothstep(0.007, 0.0, off) * 7.0 + smoothstep(0.09, 0.0, off) * 0.35);
  }
  return c + vec3(0.7, 0.75, 1.0) * uFlash;
}

// Fog by the distance from the house: uFog = (start, length, most).
float fogAt(vec3 p) {
  return uFog.z * (1.0 - exp(-max(houseDist(p) - uFog.x, 0.0) / uFog.y));
}

// A see-through stage: the landscape fades out between uFade.x and uFade.y metres out.
float fadeAt(vec3 p) {
  return uFade.y > 0.0 ? 1.0 - smoothstep(uFade.x, uFade.y, houseDist(p)) : 1.0;
}
`;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * The sky for `config.site`. `opaque`: draw the dome (else the stage is see-through and the
 * landscape fades out instead). `center`, `camDir`: the house's middle and the camera's side;
 * `wake()` asks the stage for a frame (a new reading came in).
 */
export function createSky({ config, scene, camera, renderer, opaque, center, camDir, wake = () => {} }) {
  const site = config.site;
  const { minX, minZ, maxX, maxZ } = config.bounds;
  const u = {
    uNoise: { value: noiseTexture() },
    uTime: { value: 0 },
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonLight: { value: 0 },
    uStars: { value: 0 },
    uCover: { value: 0 },
    uCloudShift: { value: new THREE.Vector2() },
    uCloudLit: { value: new THREE.Color() },
    uCloudDark: { value: new THREE.Color() },
    uCloudShade: { value: 0.5 },
    uFlash: { value: 0 },
    uFogColor: { value: new THREE.Color() },
    uFog: { value: new THREE.Vector3(120, 700, 0.7) },
    uHouse: { value: new THREE.Vector4(minX, minZ, maxX, maxZ) },
    uFade: { value: new THREE.Vector2(opaque ? 0 : 20, opaque ? 0 : 28) },
    uWind: { value: new THREE.Vector3(1, 0, 2) },   // x, z: the way it blows; z: m/s
    uWet: { value: 0 },
    uSnowCover: { value: 0 },
    uFrost: { value: 0 },
    uRain: { value: 0 },
    uBolt: { value: new THREE.Vector3() },          // x: its bearing (atan2(x, z)), y: brightness, z: its shape
  };
  const group = new THREE.Group();
  scene.add(group);

  /* ---------- the dome ---------- */

  let dome = null;
  if (opaque) {
    dome = new THREE.Mesh(new THREE.SphereGeometry(DOME, 48, 24), new THREE.ShaderMaterial({
      uniforms: u, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: SKY_GLSL + /* glsl */`
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          vec3 c = skyColor(vec3(dir.x, max(dir.y, 0.0), dir.z));
          // Below the horizon only the far haze shows (the ground hides the rest).
          c = mix(c, uFogColor, smoothstep(0.02, -0.08, dir.y));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    group.add(dome);
  }

  /* ---------- rain, drizzle, hail and snow ---------- */

  // Each falls through a box around the house and wraps round; nothing is drawn inside the
  // building's outline below its roof line (the rooms have no roof), so it falls around the
  // model and onto its roof, never through it.
  const fallUniforms = {
    uTime: u.uTime,
    uCenter: { value: new THREE.Vector2(center.x, center.z) },
    uBox: { value: new THREE.Vector4(minX - 0.15, minZ - 0.15, maxX + 0.15, maxZ + 0.15) },
    uRoof: { value: config.wallHeight + 0.1 },
    uDrift: { value: new THREE.Vector2() },     // m/s sideways
    uSpeed: { value: 9 },                       // m/s down
    uLen: { value: 0.9 },
    uSize: { value: 0.05 },
    uColor: { value: new THREE.Color() },
    uAlpha: { value: 0.4 },
    uHalfH: { value: 400 },                     // half the drawing buffer's height, in pixels
    uBounce: { value: 0 },
  };
  const FALL_GLSL = /* glsl */`
    uniform float uTime;
    uniform vec2 uCenter;
    uniform vec4 uBox;
    uniform float uRoof;
    uniform vec2 uDrift;
    uniform float uSpeed;
    attribute vec4 aDrop;
    // Where this drop is now: falling, drifting with the wind, wrapped round in the box.
    vec3 dropAt(float sway) {
      float fallen = mod(aDrop.y + (uTime + aDrop.w * 50.0) * uSpeed, ${VOLUME_H.toFixed(1)});
      float y = ${VOLUME_H.toFixed(1)} - fallen;
      vec2 xz = aDrop.xz + uDrift * (uTime + aDrop.w * 50.0);
      xz += sway * vec2(sin(uTime * 0.9 + aDrop.w * 40.0), cos(uTime * 0.7 + aDrop.w * 23.0));
      xz = mod(xz - uCenter + ${(VOLUME / 2).toFixed(1)}, ${VOLUME.toFixed(1)}) + uCenter - ${(VOLUME / 2).toFixed(1)};
      return vec3(xz.x, y, xz.y);
    }
    float insideHouse(vec3 p) {
      return step(uBox.x, p.x) * step(p.x, uBox.z) * step(uBox.y, p.z) * step(p.z, uBox.w) * step(p.y, uRoof);
    }`;

  function dropsGeometry(count, seed, lines) {
    const drops = new Float32Array(count * 4 * (lines ? 2 : 1));
    const ends = lines ? new Float32Array(count * 2) : null;
    let s = seed;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < count; i++) {
      const d = [center.x + (rand() - 0.5) * VOLUME, rand() * VOLUME_H, center.z + (rand() - 0.5) * VOLUME, rand()];
      for (let k = 0; k < (lines ? 2 : 1); k++) {
        drops.set(d, (i * (lines ? 2 : 1) + k) * 4);
        if (lines) ends[i * 2 + k] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aDrop', new THREE.BufferAttribute(drops, 4));
    if (lines) geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    // Positions are made up in the shader: a box that always passes the frustum test.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3 * (lines ? 2 : 1)), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(center.x, VOLUME_H / 2, center.z), VOLUME);
    return geo;
  }

  const RAIN_MAX = 4200;
  const rain = new THREE.LineSegments(dropsGeometry(RAIN_MAX, 99, true), new THREE.ShaderMaterial({
    uniforms: fallUniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader: FALL_GLSL + /* glsl */`
      uniform float uLen;
      attribute float aEnd;
      varying float vAlpha;
      void main() {
        vec3 p = dropAt(0.0);
        // The streak trails back along the way it falls; both ends share one head, so a
        // drop that wraps round never draws a line across the box.
        vec3 way = normalize(vec3(uDrift.x, -uSpeed, uDrift.y));
        p -= way * uLen * aEnd;
        float hidden = max(insideHouse(p), step(p.y, 0.0));
        vAlpha = (1.0 - hidden) * mix(1.0, 0.25, aEnd) * smoothstep(0.0, 3.0, p.y);
        gl_Position = hidden > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uAlpha;
      varying float vAlpha;
      void main() { gl_FragColor = vec4(uColor, uAlpha * vAlpha); }`,
  }));
  rain.frustumCulled = false;
  rain.visible = false;
  rain.renderOrder = 5; // after the land, which a see-through stage draws as transparent too
  group.add(rain);

  const flakeUniforms = { ...fallUniforms, uSpeed: { value: 1.1 }, uDrift: { value: new THREE.Vector2() }, uSize: { value: 0.06 }, uColor: { value: new THREE.Color() }, uAlpha: { value: 0.9 } };
  const FLAKE_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uAlpha;
    varying float vAlpha;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      gl_FragColor = vec4(uColor, uAlpha * vAlpha * smoothstep(0.5, 0.15, r));
    }`;
  const FLAKES_MAX = 3200;
  const flakes = new THREE.Points(dropsGeometry(FLAKES_MAX, 7, false), new THREE.ShaderMaterial({
    uniforms: flakeUniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader: FALL_GLSL + /* glsl */`
      uniform float uSize;
      uniform float uHalfH;
      uniform float uBounce;
      varying float vAlpha;
      void main() {
        vec3 p = dropAt(0.45 * (1.0 - uBounce));
        // Hail: a little hop where it lands.
        if (uBounce > 0.0) {
          float t = fract((uTime + aDrop.w * 50.0) * 0.9 + aDrop.w * 7.0);
          if (p.y < 0.6) p.y = 0.05 + abs(sin(t * 18.0)) * 0.35 * (1.0 - t);
        }
        float hidden = max(insideHouse(p), step(p.y, 0.0));
        vAlpha = 1.0 - hidden;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = hidden > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
        gl_PointSize = clamp(uSize * (0.6 + aDrop.w) * projectionMatrix[1][1] * uHalfH / -mv.z, 1.5, 7.0);
      }`,
    fragmentShader: FLAKE_FRAG,
  }));
  flakes.frustumCulled = false;
  flakes.visible = false;
  flakes.renderOrder = 5;
  group.add(flakes);

  /* ---------- lightning ---------- */

  // A bolt is drawn in the sky itself (skyColor): the camera looks down on the model, so it
  // is seen where the sky is, in the lake's reflection (and on the dome of an opaque stage).
  // It strikes beyond the house, in the direction the camera looks.
  const ahead = Math.atan2(-camDir.x, -camDir.z);
  let boltOn = false;
  function strike() {
    boltOn = Math.random() > 0.4; // the rest are flashes in the clouds
    u.uBolt.value.set(ahead + (Math.random() - 0.5) * 0.3, 0, Math.random());
  }

  /* ---------- state ---------- */

  let reading = weather.reading;
  let sunAt = -Infinity;     // when the sun and moon were last placed (performance.now())
  let clock = 0;             // seconds since the sky was made (drives uTime)
  let lastNow = performance.now();
  const sun = { altitude: 0, dir: new THREE.Vector3(0, 1, 0) };
  const moon = { altitude: -10, dir: new THREE.Vector3(0, -1, 0), lit: 0 };
  // The look, eased towards `goal`.
  const make = () => ({
    zenith: new THREE.Color(), horizon: new THREE.Color(), glow: new THREE.Color(), fog: new THREE.Color(),
    cloudLit: new THREE.Color(), cloudDark: new THREE.Color(), sunColor: new THREE.Color(),
    hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), light: new THREE.Color(),
    hemi: 0, lightI: 0, exposure: 1, bloom: 0.2, threshold: 1.2, stars: 0, moonLight: 0, cover: 0,
    fogStart: 120, fogLen: 700, fogMax: 0.7, haze: 0, wet: 0, snowCover: 0, frost: 0, cloudShade: 0.5, shadows: 0,
    dir: new THREE.Vector3(0, 1, 0),
  });
  const look = make();
  const goal = make();
  let fresh = true;          // the first look is taken at once, not eased into
  let flash = 0;             // lightning, 0..1
  let flashT = -1;           // seconds into the current flash
  let nextFlash = 4 + Math.random() * 6;
  let storm = false;
  let precip = null;         // what falls: { kind: 'rain' | 'snow' | 'hail', ... } or null

  // Today's night light: steep, from the viewer's side.
  const NIGHT = new THREE.Vector3(camDir.x * 3.2 + 1.5, 10, camDir.z * 3.2 - 1.5).normalize();

  const unsubscribe = weather.subscribe((r) => { reading = r; place(); wake(); });

  function place() {
    const now = weather.now(site.lon);
    const s = sunPosition(now, site.lat, site.lon);
    const m = moonPosition(now, site.lat, site.lon);
    sun.altitude = s.altitude;
    planDirection(s.bearing, s.altitude, site.planUp, sun.dir);
    moon.altitude = m.altitude;
    moon.lit = m.lit;
    planDirection(m.bearing, m.altitude, site.planUp, moon.dir);
    aim();
  }

  // Where every part of the look should be for the sun, the moon and the weather now.
  function aim() {
    const r = reading || PLAIN;
    const kind = r.kind || 'partly';
    const cover = Math.min(1, Math.max(0, (r.cloud ?? 35) / 100));
    const grey = cover ** 1.4;
    const gloom = (GLOOM[kind] || 0) * (0.5 + cover * 0.5);
    const day = daylight(sun.altitude);
    const g = goal;
    // Twilight: a warm band towards the sun just before it rises and after it sets.
    const tw = Math.exp(-(((sun.altitude + 1) / 6) ** 2)) * (1 - cover * 0.75);
    const moonUp = THREE.MathUtils.smoothstep(moon.altitude, -2, 8);

    g.zenith.copy(PAL.dayZenith).lerp(PAL.greyZenith, grey).lerp(PAL.stormZenith, gloom * 1.2);
    g.horizon.copy(PAL.dayHorizon).lerp(PAL.greyHorizon, grey).lerp(PAL.stormHorizon, gloom * 1.2);
    const nz = PAL.nightZenith.clone().lerp(PAL.nightGreyZenith, cover);
    const nh = PAL.nightHorizon.clone().lerp(PAL.nightGreyHorizon, cover);
    // A bright moon lifts the night sky a little.
    nz.offsetHSL(0, 0, 0.02 * moonUp * moon.lit * (1 - cover));
    g.zenith.lerpColors(nz, g.zenith, day).lerp(PAL.twZenith, tw * 0.45);
    g.horizon.lerpColors(nh, g.horizon, day).lerp(PAL.twHorizon, tw * 0.7);
    g.glow.copy(PAL.twGlow).multiplyScalar(tw * 0.55);
    g.sunColor.copy(PAL.sunLow).lerp(PAL.sunNoon, THREE.MathUtils.smoothstep(sun.altitude, 0, 25))
      .multiplyScalar(THREE.MathUtils.smoothstep(sun.altitude, -1, 2) * (1 - grey * 0.97));
    g.moonLight = moonUp * (0.35 + moon.lit * 0.65) * (1 - cover * 0.95);
    g.stars = (1 - day) * (1 - cover) ** 2 * (1 - 0.6 * moonUp * moon.lit);
    g.cover = cover;
    g.cloudLit.lerpColors(PAL.cloudNight, PAL.cloudDay, day).lerp(PAL.cloudDusk, tw * 0.6).lerp(PAL.cloudGrey, gloom);
    g.cloudDark.copy(g.cloudLit).lerp(PAL.stormZenith, 0.45 + gloom * 0.4).multiplyScalar(0.35 + day * 0.65);
    g.cloudShade = 0.3 + gloom;
    // Freezing drizzle and rain: a cold blue-grey cast.
    const icy = [56, 57, 66, 67].includes(r.code) ? 0.35 : 0;
    // Cloud shadows on the land: by day, under broken cloud (overcast is all shade already).
    g.shadows = day * THREE.MathUtils.smoothstep(cover, 0.03, 0.2) * (1 - THREE.MathUtils.smoothstep(cover, 0.8, 0.98)) * (1 - gloom);

    // Haze: far hills fade softly; fog swallows the field and the lake within 60–150 m.
    if (kind === 'fog') {
      const vis = Math.min(1000, Math.max(60, r.visibility ?? 150));
      Object.assign(g, { fogStart: 0, fogLen: Math.min(30, Math.max(8, vis / 10)), fogMax: 1, haze: 0.011 });
      g.fog.lerpColors(PAL.fogNight, PAL.fogDay, day);
    } else {
      const vis = Math.min(24000, Math.max(1000, r.visibility ?? 24000));
      const rainy = kind === 'rain' || kind === 'storm' || kind === 'snow' || kind === 'drizzle';
      Object.assign(g, { fogStart: rainy ? 25 : 120, fogLen: rainy ? 260 : vis / 20, fogMax: rainy ? 0.85 : 0.75, haze: 0 });
      g.fog.copy(g.horizon);
    }

    // The ground: wet in the rain, white under snow, frosted by rime fog.
    g.wet = { rain: 1, storm: 1, drizzle: 0.55 }[kind] ?? 0;
    g.snowCover = Math.max(THREE.MathUtils.smoothstep(r.snowDepth ?? 0, 0.01, 0.05), kind === 'snow' ? 0.35 : 0);
    g.frost = r.code === 48 ? 1 : 0;

    // The stage: night is today's dark look (lamps glowing), a clear noon its light look.
    const sunVis = (1 - 0.82 * cover ** 1.6) * (1 - gloom);
    g.hemiSky.lerpColors(PAL.hemiNight, PAL.hemiDay.clone().lerp(g.horizon, 0.25), day)
      .lerp(PAL.hemiGrey, day * grey * 0.6).lerp(PAL.hemiDusk, tw * 0.5).lerp(PAL.icy, icy);
    g.horizon.lerp(PAL.icy, icy * 0.5);
    g.zenith.lerp(PAL.icy, icy * 0.3);
    g.hemiGround.lerpColors(PAL.groundNight, g.snowCover > 0.5 ? PAL.groundSnow : PAL.groundDay, day);
    g.hemi = (0.42 + (1.55 - 0.42) * day) * (1 + 0.12 * cover * day) * (1 - 0.6 * gloom);
    const moonI = 0.6 * (0.7 + 0.3 * moonUp * moon.lit);
    const sunI = 2.1 * sunVis * THREE.MathUtils.smoothstep(sun.altitude, -3, 7);
    g.lightI = moonI + (sunI - moonI) * day;
    g.light.lerpColors(PAL.moonLight, PAL.sunLow.clone().lerp(PAL.sunNoon, THREE.MathUtils.smoothstep(sun.altitude, 2, 22)), day);
    g.exposure = (1.05 + (1.0 - 1.05) * day) * (1 - 0.18 * gloom);
    g.bloom = 0.34 + (0.14 - 0.34) * day;
    g.threshold = 1.0 + (1.35 - 1.0) * day;

    // The light comes from the sun by day and the moon by night, never too low to read the
    // rooms by; with no moon up, from where the stage's night light always came.
    const sunDir = lift(sun.dir, MIN_SUN, new THREE.Vector3());
    const moonDir = moon.altitude > 2 ? lift(moon.dir, MIN_MOON, new THREE.Vector3()) : NIGHT.clone();
    const night = moonDir.lerp(NIGHT, 1 - moonUp);
    g.dir.copy(night).lerp(sunDir, THREE.MathUtils.smoothstep(day, 0.25, 0.75)).normalize();

    // What falls, and how much of it.
    const wind = Math.min(60, r.wind ?? 0) / 3.6; // m/s
    const towards = planDirection((r.windDir ?? 225) + 180, 0, site.planUp);
    u.uWind.value.set(towards.x, towards.z, wind);
    storm = kind === 'storm';
    if (kind === 'snow') {
      const grains = r.code === 77;
      precip = { kind: 'snow', count: grains ? 700 : Math.round(Math.min(FLAKES_MAX, Math.max(1200, (r.snow || 0.5) * 2600))), size: grains ? 0.05 : 0.1, speed: grains ? 1.6 : 1.1, drift: Math.min(wind, 9) * 0.55 };
    } else if (kind === 'rain' || kind === 'storm' || kind === 'drizzle') {
      const drizzle = kind === 'drizzle';
      const rate = Math.max(r.precip || 0, drizzle ? 0.2 : 1);
      precip = {
        kind: 'rain', drizzle,
        count: Math.round(Math.min(RAIN_MAX, drizzle ? 2600 : 900 + rate * 400 + (storm ? 1200 : 0))),
        speed: drizzle ? 4 : storm ? 12 : 9.5, len: drizzle ? 0.22 : storm ? 1.25 : 0.95,
        drift: Math.min(wind, 15) * 0.6, hail: storm && (r.code === 96 || r.code === 99),
      };
    } else precip = null;
    u.uRain.value = precip?.kind === 'rain' ? Math.min(1, (precip.drizzle ? 0.3 : 0.5) + (r.precip || 0) / 8) : 0;
    rain.visible = precip?.kind === 'rain';
    flakes.visible = precip?.kind === 'snow' || Boolean(precip?.hail);
    if (precip?.kind === 'rain') {
      rain.geometry.setDrawRange(0, precip.count * 2);
        fallUniforms.uSpeed.value = precip.speed;
      fallUniforms.uLen.value = precip.len;
      fallUniforms.uDrift.value.set(towards.x, towards.z).multiplyScalar(precip.drift);
      fallUniforms.uAlpha.value = precip.drizzle ? 0.42 : storm ? 0.6 : 0.55;
    }
    if (precip?.kind === 'snow' || precip?.hail) {
      const hail = precip.kind !== 'snow';
      flakes.geometry.setDrawRange(0, hail ? 500 : precip.count);
      flakeUniforms.uSpeed.value = hail ? 13 : precip.speed;
      flakeUniforms.uSize.value = hail ? 0.04 : precip.size;
      flakeUniforms.uBounce.value = hail ? 1 : 0;
      flakeUniforms.uDrift.value.set(towards.x, towards.z).multiplyScalar(hail ? precip.drift * 0.3 : precip.drift);
    }
    if (fresh) { snap(); fresh = false; }
  }

  function snap() {
    for (const k of Object.keys(goal)) {
      if (goal[k]?.isColor || goal[k]?.isVector3) look[k].copy(goal[k]);
      else look[k] = goal[k];
    }
  }

  // Eases the look towards the goal; true while it is still on its way.
  function ease(dt) {
    const k = 1 - Math.exp(-dt * EASE);
    let moving = false;
    for (const key of Object.keys(goal)) {
      const [a, b] = [look[key], goal[key]];
      if (a?.isColor) {
        const d = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
        if (d > 0.002) { a.lerp(b, k); moving = true; } else a.copy(b);
      } else if (a?.isVector3) {
        if (a.distanceToSquared(b) > 1e-6) { a.lerp(b, k).normalize(); moving = true; } else a.copy(b);
      } else if (Math.abs(a - b) > 1e-3 * Math.max(1, Math.abs(b))) { look[key] = a + (b - a) * k; moving = true; } else look[key] = b;
    }
    return moving;
  }

  function write() {
    u.uZenith.value.copy(look.zenith);
    u.uHorizon.value.copy(look.horizon);
    u.uGlow.value.copy(look.glow);
    u.uSunDir.value.copy(sun.dir);
    u.uSunColor.value.copy(look.sunColor);
    u.uMoonDir.value.copy(moon.dir);
    u.uMoonLight.value = look.moonLight;
    u.uStars.value = look.stars;
    u.uCover.value = look.cover;
    u.uCloudLit.value.copy(look.cloudLit).multiplyScalar(1 + flash * 1.5);
    u.uCloudDark.value.copy(look.cloudDark).multiplyScalar(1 + flash * 3);
    u.uCloudShade.value = look.cloudShade;
    u.uFlash.value = flash * 0.5;
    u.uFogColor.value.copy(look.fog).multiplyScalar(1 + flash * 0.8);
    u.uFog.value.set(look.fogStart, look.fogLen, look.fogMax);
    u.uWet.value = look.wet;
    u.uSnowCover.value = look.snowCover;
    u.uFrost.value = look.frost;
    // Rain and snow catch the light of the sky around them.
    const lit = 0.25 + Math.min(1, look.hemi / 1.5) * 0.75;
    fallUniforms.uColor.value.copy(PAL.rain).multiplyScalar(lit * (1 + flash * 2));
    flakeUniforms.uColor.value.copy(PAL.snow).multiplyScalar(0.35 + lit * 0.75 + flash);
    const size = renderer.getDrawingBufferSize(tmp2);
    fallUniforms.uHalfH.value = flakeUniforms.uHalfH.value = size.y / 2;
    if (dome) dome.position.copy(camera.position);
  }
  const tmp2 = new THREE.Vector2();

  const still = () => reducedMotion.matches;

  // Lightning: a flash every 6–20 s, two quick pulses; sometimes a bolt over the lake.
  function stepStorm(dt) {
    if (!storm || still()) {
      if (flash || boltOn) { flash = 0; flashT = -1; boltOn = false; u.uBolt.value.y = 0; return true; }
      return false;
    }
    nextFlash -= dt;
    if (nextFlash <= 0 && flashT < 0) { flashT = 0; strike(); nextFlash = 6 + Math.random() * 14; }
    if (flashT < 0) return false;
    flashT += dt;
    flash = Math.exp(-flashT / 0.07) + (flashT > 0.16 ? 0.7 * Math.exp(-(flashT - 0.16) / 0.12) : 0);
    u.uBolt.value.y = boltOn && flashT < 0.3 ? 1 - flashT / 0.3 : 0;
    if (flashT > 0.9) {
      flash = 0;
      flashT = -1;
      boltOn = false;
    }
    return true;
  }

  return {
    uniforms: u,
    look,
    /** Lightning, 0..1: the stage's light jumps with it. */
    get flash() { return flash; },
    /** Which way the light comes from (unit vector, towards it). */
    get lightDir() { return look.dir; },
    /** The hub's reading in use (null: none, the plain look). */
    get reading() { return reading; },
    get precip() { return precip; },

    /**
     * One frame: places the sun and moon now and then, eases the look, moves clouds, water
     * and weather. Returns { changed, fps }: whether the look moved (render now), and how
     * often the sky wants a frame (once in a while when it is still: the sun moves on).
     */
    update(nowMs = performance.now()) {
      const dt = Math.min(0.1, Math.max(0, (nowMs - lastNow) / 1000));
      lastNow = nowMs;
      let changed = false;
      if (nowMs - sunAt >= SUN_EVERY * 1000) { sunAt = nowMs; place(); changed = true; }
      changed = ease(dt) || changed;
      const moving = !still();
      if (moving) {
        clock += dt;
        u.uTime.value = clock;
        const w = u.uWind.value;
        // The clouds drift with the wind (faster than life, so it shows).
        u.uCloudShift.value.x -= w.x * Math.max(1, w.z) * 3 * dt;
        u.uCloudShift.value.y -= w.y * Math.max(1, w.z) * 3 * dt;
      } else {
        u.uTime.value = 37.0;   // rain and snow stand still, as streaks and flakes
      }
      changed = stepStorm(dt) || changed;
      write();
      // Still (reduced motion): a frame now and then all the same, as the sun moves on.
      const fps = !moving ? 1 / SUN_EVERY : (precip || storm) ? WEATHER_FPS : AMBIENT_FPS;
      return { changed, fps };
    },

    /** Jumps to the look for now (tests and screenshots). */
    settle() {
      sunAt = performance.now();
      place();
      snap();
      write();
    },

    dispose() {
      unsubscribe();
      scene.remove(group);
      dome?.geometry.dispose();
      dome?.material.dispose();
      rain.geometry.dispose();
      rain.material.dispose();
      flakes.geometry.dispose();
      flakes.material.dispose();
    },
  };
}

// A plan side ('north' is -z) as a unit vector in x/z, or null.
export function sideVector(side) {
  return { north: new THREE.Vector2(0, -1), south: new THREE.Vector2(0, 1), east: new THREE.Vector2(1, 0), west: new THREE.Vector2(-1, 0) }[side] || null;
}

// `dir` with its altitude raised to at least `min` degrees, azimuth kept.
function lift(dir, min, out) {
  const alt = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  const want = Math.max(alt, THREE.MathUtils.degToRad(min));
  const flat = Math.hypot(dir.x, dir.z) || 1;
  return out.set((dir.x / flat) * Math.cos(want), Math.sin(want), (dir.z / flat) * Math.cos(want));
}

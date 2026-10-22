// The land around the house (docs/landscape-weather.md): a yard of grass, the lake on one
// side with its sandy bank and the far shore's dry hills, a farm field on the other with its
// crop rows running away from the house, and dry scrub with a few sagebrush clumps between.
// Low-poly and stylised like the model. Nothing rises above the floor within 1.5 m of the
// walls, nothing stands between the camera and the house, and nothing is picked by a tap.
// Lit by the sky (sky.js): its fog, clouds, wet ground and snow come in through its uniforms.
import * as THREE from 'three';
import { rng } from './kit.js';
import { SKY_GLSL, sideVector } from './sky.js';
import { weather } from '../sky/weather.js';

const WATER = -0.42;        // the lake's level (the yard is at -0.05, the floors at 0)
const GROUND = -0.05;
const BANK = 2.4;           // metres of sloping sand down to the water
const FIELD_HALF = 70;      // the field's half width
const CLEAR = 1.5;          // nothing above the floor this near the walls
const REACH = 1700;         // the land goes out this far (the far shore's hills are inside it)

// The crop through the year (by month, 0 = January): [crop, furrow].
const FIELD = [
  ['#7d6650', '#5e4a39'], ['#7d6650', '#5e4a39'], ['#7d6650', '#5e4a39'], ['#7f9a4c', '#6a5440'],
  ['#5f8a3a', '#4a6c2e'], ['#5b8636', '#47692b'], ['#628a38', '#4d6d2c'], ['#c9a54a', '#a8873a'],
  ['#c4a04c', '#9e8038'], ['#b59a6a', '#6f5638'], ['#ad946a', '#6a5338'], ['#7d6650', '#5e4a39'],
];
// The yard's grass: green while it is watered, olive in the autumn, dull in the winter.
const GRASS = [
  ['#8a8a62', '#7a7a55'], ['#8a8a62', '#7a7a55'], ['#86895d', '#767a52'], ['#6f9447', '#5d813b'],
  ['#64904a', '#557d3e'], ['#5f8c46', '#4f7a3b'], ['#628b45', '#527a3a'], ['#6d8c46', '#5d7a3c'],
  ['#7d9150', '#6c8046'], ['#8b9659', '#79844d'], ['#8e9260', '#7c8053'], ['#8a8a62', '#7a7a55'],
];

const SHADER_HEAD = /* glsl */`
  varying vec3 vWorld;
`;
// Every outdoor material: where its fragment is in the world (instanced or not).
const WORLD_VERTEX = /* glsl */`
  vec4 outdoorPos = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    outdoorPos = instanceMatrix * outdoorPos;
  #endif
  vWorld = (modelMatrix * outdoorPos).xyz;
`;
// The fog by distance from the house, and the fade of a see-through stage.
const FOG_FRAGMENT = /* glsl */`
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, fogAt(vWorld));
  gl_FragColor.a *= fadeAt(vWorld);
`;

/**
 * Builds the landscape for `config.site` around the house. `sky` is the sky that lights it;
 * `camDir` the side the camera looks from; `fade`: a see-through stage (the land fades out).
 */
export function buildLandscape(config, sky, { camDir, fade }) {
  const group = new THREE.Group();
  group.name = 'landscape';
  const { minX, minZ, maxX, maxZ } = config.bounds;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const land = config.site.landscape;
  const W = sideVector(land.water);
  const F = sideVector(land.field);
  const half = (v) => Math.abs(v.x) * (maxX - minX) / 2 + Math.abs(v.y) * (maxZ - minZ) / 2;
  const halfW = W ? half(W) : 0;
  const halfF = F ? half(F) : 0;

  /* ---------- the shape of the land ---------- */

  const boxDist = (x, z) => Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
  // In a side's own frame: how far beyond the house's face (t), and how far along it (s).
  const depth = (v, h, x, z) => (x - cx) * v.x + (z - cz) * v.y - h;
  const along = (v, x, z) => -(x - cx) * v.y + (z - cz) * v.x;
  // The waterline curves gently, and runs off past both sides of the house.
  const shoreAt = (s) => Math.max(CLEAR + BANK, land.shore + 1.3 * Math.sin(s * 0.075 + 0.9) + 0.6 * Math.sin(s * 0.21 + 2.3));
  // The far shore, about 1–1.5 km out, wanders too.
  const farAt = (s) => 1050 + 260 * Math.sin(s * 0.0021 + 1.3) + 90 * Math.sin(s * 0.0071);
  const bumps = (x, z) => Math.sin(x * 0.31 + z * 0.17) * 0.5 + Math.sin(x * 0.11 - z * 0.27 + 1.7) * 0.35 + Math.sin(x * 0.53 + z * 0.61 + 4.1) * 0.15;
  const hills = (s) => 0.55 + 0.25 * Math.sin(s * 0.009 + 0.4) + 0.2 * Math.sin(s * 0.023 + 2.2);
  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

  // The height of the land at (x, z), and how much of it is field, sand and scrub.
  function at(x, z) {
    const d = boxDist(x, z);
    let h = GROUND + bumps(x, z) * (smooth(CLEAR + 0.5, 12, d) * 0.22 + smooth(40, 160, d) * 1.4);
    let field = 0;
    let sand = 0;
    let scrub = smooth(9, 22, d);
    if (F) {
      const t = depth(F, halfF, x, z);
      const s = Math.abs(along(F, x, z));
      // A flat field from `fieldEdge` on, as wide as a farm, out to the horizon.
      const inField = smooth(land.fieldEdge - 0.2, land.fieldEdge + 0.2, t) * (1 - smooth(FIELD_HALF - 4, FIELD_HALF + 4, s));
      const flat = smooth(land.fieldEdge - 4, land.fieldEdge, t) * (1 - smooth(FIELD_HALF, FIELD_HALF + 12, s));
      h += (GROUND - h) * flat;
      field = inField;
      scrub *= 1 - smooth(land.fieldEdge - 6, land.fieldEdge, t) * (1 - smooth(FIELD_HALF - 4, FIELD_HALF + 10, s));
    }
    if (W) {
      const t = depth(W, halfW, x, z);
      const s = along(W, x, z);
      const shore = shoreAt(s);
      // The yard runs down to the lake as a lawn; then sand and water.
      scrub *= 1 - smooth(shore - 12, shore - 4, t) * (1 - smooth(40, 70, Math.abs(s)));
      const k = smooth(shore - BANK, shore, t);
      h += (WATER - 0.14 - h) * k;
      if (t > shore) h = WATER - 0.14 - Math.min(1.6, (t - shore) * 0.12);
      sand = smooth(shore - BANK - 0.5, shore - BANK + 0.3, t);
      field *= 1 - smooth(shore - BANK - 2, shore - BANK, t);
      // The far shore rises into low, dry hills.
      const far = farAt(s);
      if (t > far - 40) {
        const rise = smooth(far - 40, far + 220, t);
        h = Math.max(h, WATER - 1.5 + rise * (8 + 46 * hills(s) * smooth(far, far + 500, t) + 6 * bumps(x * 0.05, z * 0.05)));
        sand *= 1 - smooth(far + 20, far + 80, t);
        scrub = Math.max(scrub, smooth(far, far + 60, t));
      }
    }
    return { h, field, sand, scrub: Math.min(1, scrub) };
  }

  /* ---------- the ground: rings around the house, fine near it, coarse far out ---------- */

  const radii = [0];
  for (let r = 0.5; r <= 45; r += 0.5) radii.push(r);
  for (let r = 45 * 1.075; r < REACH; r *= 1.075) radii.push(r);
  radii.push(REACH);
  const SEG = 256;
  const pos = new Float32Array(radii.length * SEG * 3);
  const zone = new Float32Array(radii.length * SEG * 3);
  radii.forEach((r, i) => {
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const p = at(x, z);
      const k = (i * SEG + j) * 3;
      pos[k] = x; pos[k + 1] = p.h; pos[k + 2] = z;
      zone[k] = p.field; zone[k + 1] = p.sand; zone[k + 2] = p.scrub;
    }
  });
  const index = [];
  for (let i = 0; i < radii.length - 1; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * SEG + j;
      const b = i * SEG + ((j + 1) % SEG);
      const c = a + SEG;
      const d = b + SEG;
      index.push(a, b, c, b, d, c); // facing up
    }
  }
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  groundGeo.setAttribute('aZone', new THREE.BufferAttribute(zone, 3));
  groundGeo.setIndex(index);
  groundGeo.computeVertexNormals();

  const seasonal = {
    uGrassA: { value: new THREE.Color() }, uGrassB: { value: new THREE.Color() },
    uFieldA: { value: new THREE.Color() }, uFieldB: { value: new THREE.Color() },
    uScrubA: { value: new THREE.Color('#a39a75') }, uScrubB: { value: new THREE.Color('#878f72') },
    uSand: { value: new THREE.Color('#cdb88f') },
    uFieldOrigin: { value: new THREE.Vector2(cx, cz) },
    uFieldAcross: { value: F ? new THREE.Vector2(-F.y, F.x) : new THREE.Vector2(1, 0) },
    uShadows: { value: 0 },
  };
  function season() {
    const month = weather.now(config.site.lon).getUTCMonth();
    seasonal.uFieldA.value.set(FIELD[month][0]);
    seasonal.uFieldB.value.set(FIELD[month][1]);
    seasonal.uGrassA.value.set(GRASS[month][0]);
    seasonal.uGrassB.value.set(GRASS[month][1]);
  }
  season();

  const ground = new THREE.Mesh(groundGeo, outdoor(new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), 'ground', {
    uniforms: seasonal,
    vertexHead: 'attribute vec3 aZone;\nvarying vec3 vZone;',
    vertex: 'vZone = aZone;',
    fragmentHead: /* glsl */`
      varying vec3 vZone;
      uniform vec3 uGrassA; uniform vec3 uGrassB; uniform vec3 uFieldA; uniform vec3 uFieldB;
      uniform vec3 uScrubA; uniform vec3 uScrubB; uniform vec3 uSand;
      uniform vec2 uFieldOrigin; uniform vec2 uFieldAcross; uniform float uShadows;
      float fieldRow;
      vec3 puddleSky;`,
    color: /* glsl */`
      vec2 q = vWorld.xz;
      float n1 = texture2D(uNoise, q / 23.0).g;
      float n2 = texture2D(uNoise, q / 6.5).b;
      float breeze = min(1.0, uWind.z / 6.0) * sin(dot(q, uWind.xy) * 0.35 - uTime * (0.8 + uWind.z * 0.2));
      vec3 grass = mix(uGrassA, uGrassB, smoothstep(0.25, 0.75, n1) * 0.7) * (1.0 + 0.025 * breeze);
      vec3 scrub = mix(uScrubA, uScrubB, smoothstep(0.35, 0.75, n2 * 0.55 + n1 * 0.45));
      vec3 sand = uSand * (0.9 + 0.12 * n2);
      // Crop rows running away from the house, a slow shimmer moving across them with the wind.
      float across = dot(q - uFieldOrigin, uFieldAcross);
      fieldRow = 0.5 + 0.5 * cos(across * 6.2832 / 0.9);
      // Rows closer together on screen than a few pixels blend into one colour.
      float rowsSeen = 1.0 - smoothstep(0.12, 0.35, fwidth(across) / 0.9);
      vec3 field = mix(uFieldA, mix(uFieldA, uFieldB, 0.5), 1.0 - rowsSeen);
      field = mix(field, uFieldB, smoothstep(0.5, 0.95, fieldRow) * rowsSeen * 0.75);
      field *= (1.0 + 0.06 * breeze) * (0.94 + 0.1 * n1);
      vec3 col = mix(grass, scrub, vZone.z);
      col = mix(col, sand, vZone.y);
      col = mix(col, field, vZone.x);
      // Grey days wash the colour out; rain darkens the ground.
      col = mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))), uCover * 0.32 + uWet * 0.1);
      col *= 1.0 - 0.3 * uWet * (1.0 - vZone.y * 0.4);
      col = mix(col, vec3(0.85, 0.89, 0.93), uFrost * 0.5 * (0.6 + 0.4 * n2));
      // Snow lies white, the rows still showing faintly; not under the water.
      float lying = uSnowCover * smoothstep(${(WATER - 0.05).toFixed(2)}, ${(WATER + 0.1).toFixed(2)}, vWorld.y);
      col = mix(col, vec3(0.84, 0.87, 0.92) * (1.0 - vZone.x * smoothstep(0.6, 0.95, fieldRow) * 0.14), lying);
      // In the rain, puddles in the yard mirror the sky.
      float puddle = uWet * (1.0 - lying) * (1.0 - vZone.x) * (1.0 - vZone.y)
        * smoothstep(0.95 - 0.03 * uWet, 0.985 - 0.03 * uWet, texture2D(uNoise, q / 14.0 + 0.23).g)
        * smoothstep(${(GROUND - 0.1).toFixed(2)}, ${GROUND.toFixed(2)}, vWorld.y);
      vec3 view = normalize(vWorld - cameraPosition);
      vec2 rip = (texture2D(uNoise, q / 1.3 + uTime * 0.05).gb - 0.5) * 0.12 * uRain;
      puddleSky = skyColor(normalize(reflect(view, normalize(vec3(rip.x, 1.0, rip.y))))) * puddle * 0.2;
      col *= 1.0 - puddle * 0.6;
      // Cloud shadows drifting over the land.
      col *= 1.0 - 0.32 * uShadows * cloudDensity(q, 340.0);
      diffuseColor.rgb = col;`,
    roughness: 'roughnessFactor = mix(roughnessFactor, 0.4, uWet * 0.75 * (1.0 - vZone.x * 0.4));',
    emissive: 'totalEmissiveRadiance += puddleSky;',
  }, fade));
  ground.receiveShadow = true;
  ground.renderOrder = fade ? 1 : 0;
  group.add(ground);

  /* ---------- the lake ---------- */

  let water = null;
  const waterUniforms = { uDeep: { value: new THREE.Color() }, uFoam: { value: new THREE.Color() } };
  if (W) {
    // A grid in the lake's own frame: fine along the near shore, coarse out to the far one.
    const ss = [];
    for (let s = -REACH; s < -60; s *= 0.8) ss.push(s);
    for (let s = -60; s <= 60; s += 0.5) ss.push(s);
    for (let s = 60 / 0.8; s < REACH; s /= 0.8) ss.push(s);
    ss.push(REACH);
    const ts = [];
    for (let t = -4; t <= 8; t += 0.5) ts.push(t);
    for (let t = 9; t < REACH; t *= 1.25) ts.push(t);
    ts.push(REACH);
    const wpos = [];
    const shore = [];
    for (const t of ts) {
      for (const s of ss) {
        const line = shoreAt(s) - BANK * 0.32; // where the bank meets the water
        const tt = line + t;
        wpos.push(cx + W.x * (halfW + tt) - W.y * s, WATER, cz + W.y * (halfW + tt) + W.x * s);
        shore.push(t);
      }
    }
    const widx = [];
    for (let i = 0; i < ts.length - 1; i++) {
      for (let j = 0; j < ss.length - 1; j++) {
        const a = i * ss.length + j;
        const b = a + 1;
        const c = a + ss.length;
        const d = c + 1;
        widx.push(a, b, c, b, d, c); // facing up
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
    geo.setAttribute('aShore', new THREE.Float32BufferAttribute(shore, 1));
    geo.setIndex(widx);
    water = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { ...sky.uniforms, ...waterUniforms },
      transparent: fade,
      fog: false,
      vertexShader: /* glsl */`
        attribute float aShore;
        varying vec3 vWorld;
        varying float vShore;
        void main() {
          vShore = aShore;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: SKY_GLSL + /* glsl */`
        uniform vec3 uDeep;
        uniform vec3 uFoam;
        varying vec3 vWorld;
        varying float vShore;
        void main() {
          vec3 V = normalize(vWorld - cameraPosition);
          vec2 q = vWorld.xz;
          // Ripples drifting downwind, bigger and quicker in a stronger wind.
          float wind = clamp(uWind.z / 9.0, 0.06, 1.0);
          vec2 flow = uWind.xy * uTime * (0.25 + uWind.z * 0.1);
          vec2 a = (q - flow) / 11.0;
          vec2 b = (q - flow * 1.4) / 3.3 + 0.5;
          float e = 0.012;
          float h0 = texture2D(uNoise, a).g + texture2D(uNoise, b).b * 0.5;
          float hx = texture2D(uNoise, a + vec2(e, 0.0)).g + texture2D(uNoise, b + vec2(e, 0.0)).b * 0.5;
          float hz = texture2D(uNoise, a + vec2(0.0, e)).g + texture2D(uNoise, b + vec2(0.0, e)).b * 0.5;
          float tilt = 0.006 + 0.03 * wind;
          vec3 N = normalize(vec3((h0 - hx) / e * tilt, 1.0, (h0 - hz) / e * tilt));
          // Rain rings.
          float rings = 0.0;
          if (uRain > 0.0) {
            vec2 cell = q / 0.75;
            vec2 id = floor(cell);
            float h = fract(sin(dot(id, vec2(127.1, 311.7))) * 43758.5453);
            vec2 f = fract(cell) - 0.5 - (vec2(fract(h * 13.1), fract(h * 29.7)) - 0.5) * 0.4;
            float t = fract(uTime * 1.1 + h * 7.0);
            float r = length(f);
            rings = smoothstep(0.05, 0.0, abs(r - t * 0.45)) * (1.0 - t) * step(h, uRain);
            N = normalize(N + vec3(f.x, 0.0, f.y) / max(r, 0.01) * rings * 0.25);
          }
          vec3 R = reflect(V, N);
          R.y = abs(R.y);
          vec3 sky = skyColor(normalize(R));
          float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-V, N), 0.0), 5.0);
          vec3 col = mix(uDeep, sky, 0.32 + 0.6 * fresnel);
          // The sun's (or the moon's) glitter path.
          col += uSunColor * pow(max(dot(R, uSunDir), 0.0), 160.0) * 2.5;
          col += vec3(0.8, 0.85, 1.0) * uMoonLight * pow(max(dot(R, uMoonDir), 0.0), 140.0) * 1.6;
          col += uHorizon * rings * 0.08;
          // Shallow and lapping at the shore.
          float foam = smoothstep(0.6, 0.0, vShore) * (0.5 + 0.5 * texture2D(uNoise, q / 2.0 + uTime * 0.02).b);
          col = mix(col, uFoam, foam * 0.55);
          col = mix(col, uFogColor, fogAt(vWorld));
          gl_FragColor = vec4(col, fadeAt(vWorld) * smoothstep(-0.1, 0.25, vShore));
        }`,
    }));
    water.material.transparent = true; // its edge melts into the bank
    water.material.depthWrite = !fade;
    water.renderOrder = 2;
    group.add(water);
  }

  /* ---------- sagebrush, rocks and a lone tree or two ---------- */

  const rand = rng(Math.round((config.site.lat * 1000 + config.site.lon * 7) * 13) || 7);
  const camSide = (x, z) => (x - cx) * camDir.x + (z - cz) * camDir.z;
  const spot = (x, z, { near = 4 } = {}) => {
    const d = boxDist(x, z);
    if (d < near) return null;
    // Nothing between the camera and the house, however it orbits.
    if (camSide(x, z) > 0 && d < 14) return null;
    const p = at(x, z);
    if (p.field > 0.05 || p.h < GROUND - 0.2) return null;
    return p;
  };
  const leafMat = outdoor(new THREE.MeshStandardMaterial({ color: '#7f8b66', roughness: 1, flatShading: true }), 'plant', { snowTop: true }, fade);
  const sage = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), leafMat, 140);
  const m = new THREE.Matrix4();
  const q4 = new THREE.Quaternion();
  const e3 = new THREE.Euler();
  let n = 0;
  for (let tries = 0; tries < 3000 && n < sage.count; tries++) {
    const a = rand() * Math.PI * 2;
    const r = 6 + rand() ** 0.7 * 70;
    const [x, z] = [cx + Math.cos(a) * r, cz + Math.sin(a) * r];
    const p = spot(x, z, { near: 5 });
    if (!p || rand() > 0.15 + p.scrub) continue;
    // A clump: two or three small round bushes.
    const size = 0.28 + rand() * 0.24;
    for (let b = 0, count = 2 + Math.floor(rand() * 2); b < count && n < sage.count; b++) {
      const [bx, bz] = [x + (rand() - 0.5) * size * 2.2, z + (rand() - 0.5) * size * 2.2];
      const sz = size * (0.7 + rand() * 0.5);
      q4.setFromEuler(e3.set(0, rand() * 6.28, 0));
      m.compose(new THREE.Vector3(bx, p.h + sz * 0.45, bz), q4, new THREE.Vector3(sz * 1.15, sz * 0.8, sz));
      sage.setMatrixAt(n++, m);
    }
  }
  sage.count = n;
  group.add(sage);

  if (W) {
    const rockMat = outdoor(new THREE.MeshStandardMaterial({ color: '#8e8a82', roughness: 0.9, flatShading: true }), 'rock', { snowTop: true }, fade);
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMat, 22);
    let k = 0;
    for (let tries = 0; tries < 400 && k < rocks.count; tries++) {
      const s = (rand() - 0.5) * 90;
      const t = shoreAt(s) - BANK * (0.2 + rand() * 0.75);
      const x = cx + W.x * (halfW + t) - W.y * s;
      const z = cz + W.y * (halfW + t) + W.x * s;
      if (boxDist(x, z) < 3 || (camSide(x, z) > 0 && boxDist(x, z) < 14)) continue;
      const size = 0.12 + rand() * 0.32;
      q4.setFromEuler(e3.set(rand() * 3, rand() * 3, rand() * 3));
      m.compose(new THREE.Vector3(x, at(x, z).h + size * 0.2, z), q4, new THREE.Vector3(size * 1.3, size * 0.7, size));
      rocks.setMatrixAt(k++, m);
    }
    rocks.count = k;
    group.add(rocks);
  }

  // A lone tree or two (Russian olive, as along the lake), well away and never camera-side.
  const trunkMat = outdoor(new THREE.MeshStandardMaterial({ color: '#5c4a3a', roughness: 1, flatShading: true }), 'trunk', {}, fade);
  const crownMat = outdoor(new THREE.MeshStandardMaterial({ color: '#7d8a63', roughness: 1, flatShading: true }), 'crown', { snowTop: true }, fade);
  const away = new THREE.Vector2(-camDir.x, -camDir.z).normalize();
  const trees = [];
  for (const [turn, dist, size] of [[0.75, 17, 1], [-1.05, 30, 0.85]]) {
    const dir = away.clone().rotateAround(new THREE.Vector2(), turn);
    for (let r = dist; r < dist + 40; r += 3) {
      const [x, z] = [cx + dir.x * r, cz + dir.y * r];
      const p = spot(x, z, { near: 11 });
      if (!p || p.h < GROUND - 0.1) continue;
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * size, 0.2 * size, 2.4 * size, 6), trunkMat);
      trunk.position.y = 1.2 * size;
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.1 * size, 0), crownMat);
      crown.position.y = 3.3 * size;
      crown.scale.set(1.15, 0.8, 1);
      const crown2 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4 * size, 0), crownMat);
      crown2.position.set(1.1 * size, 2.7 * size, 0.6 * size);
      tree.add(trunk, crown, crown2);
      tree.position.set(x, p.h, z);
      tree.rotation.y = rand() * 6;
      trees.push(tree);
      group.add(tree);
      break;
    }
  }

  // Nothing out here is a tap target, and none of it is in the shadow map's way.
  group.traverse((o) => { o.raycast = () => {}; if (o.isMesh && o !== ground) o.castShadow = false; });

  return {
    group,
    /** The lake's colours follow the sky; the season the date. */
    update() {
      const look = sky.look;
      // The deep water is a darker, bluer version of the sky near the horizon.
      waterUniforms.uDeep.value.copy(look.horizon).multiplyScalar(0.32).lerp(new THREE.Color('#0c2a40'), 0.35)
        .multiplyScalar(0.4 + 0.6 * Math.min(1, look.hemi / 1.3));
      waterUniforms.uFoam.value.set('#e6ece8').multiplyScalar(0.12 + 0.75 * Math.min(1, look.hemi / 1.5));
      seasonal.uShadows.value = look.shadows ?? 0;
    },
    season,
    dispose() {
      group.traverse((o) => {
        if (o.isMesh) { o.geometry.dispose(); }
      });
      for (const mat of new Set([ground.material, water?.material, leafMat, trunkMat, crownMat])) mat?.dispose();
    },
  };

  // A standard material that knows where it is outdoors: the sky's fog and fade, and
  // whatever colour, roughness or snow it is given (GLSL, see the ground).
  function outdoor(material, key, { uniforms = {}, vertexHead = '', vertex = '', fragmentHead = '', color = '', roughness = '', emissive = '', snowTop = false }, fading) {
    material.transparent = fading;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, sky.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${SHADER_HEAD}\n${vertexHead}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VERTEX}\n${vertex}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SHADER_HEAD}\n${SKY_GLSL}\n${fragmentHead}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${color}${snowTop ? `
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), uSnowCover * 0.75);
          diffuseColor.rgb *= 1.0 - 0.25 * uWet;` : ''}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${roughness}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${emissive}`)
        .replace('#include <fog_fragment>', `#include <fog_fragment>\n${FOG_FRAGMENT}`);
    };
    material.customProgramCacheKey = () => `outdoor-${key}-${fading}`;
    return material;
  }
}

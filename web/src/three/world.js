// The 3D stage: renderer, camera rig, picking and the per-frame animation loop. Under the
// panel's card it is framed twice: at full size above the card at rest, and shrunk into the
// strip the expanded card leaves at the top; `setSheetProgress(p)` blends the two every frame.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildHouse } from './house.js';
import { buildFurniture } from './furniture.js';
import { LightUnit } from './lights.js';
import { ACUnit } from './ac.js';
import { TvUnit } from './tv.js';
import { tv, tvLinks } from '../tv/client.js';

export const STAGE_BG = '#0a0e1a';

// The two looks of the scene (the panel's light and dark modes): night, lit by the moon and
// the lamps, or a bright, warm day. `setTheme` blends from one to the other.
const LOOKS = {
  dark: { bg: STAGE_BG, sky: '#8ea6ff', ground: '#0b0e17', hemi: 0.42, sun: '#a9c0ff', sunI: 0.6, exposure: 1.05, bloom: 0.34, threshold: 1.0, plinth: '#141927' },
  light: { bg: '#f1ece4', sky: '#fff4e6', ground: '#a89a86', hemi: 1.55, sun: '#fff0dc', sunI: 2.1, exposure: 1.0, bloom: 0.14, threshold: 1.35, plinth: '#d9d0c4' },
};
const THEME_FADE = 0.3;    // seconds

// The TV close up: as if standing this far in front of its screen, looking straight at it,
// with this much of the cabinet and wall around the screen in view.
const TV_DIST = 0.9;
const TV_AROUND = [1.32, 1.75];
const TV_CLEAR = 0.36;     // nothing nearer the camera than this in front of the screen is drawn
const FLY = 700;           // ms, into the close-up and back
const TV_MINI_FILL = 1.3;  // over the pulled-up card the close-up is cut to a window this much
const TV_MINI_ASPECT = 2;  // smaller than its frame, twice as wide as it is tall
const FOV = 24;
const NEAR = 0.5;

const rad = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;
const ORBIT_AZ = 40;       // degrees of freedom either side of the plan's default view
const EL_MIN = 26;
const EL_MAX = 70;
const ZOOM_MIN = 0.55;     // closest
const ZOOM_MAX = 1.2;

// `background: null` leaves the stage see-through, for a panel drawn on glass. `theme`:
// 'dark' (the default) or 'light'.
export function createWorld(canvas, config, store, { onHover, onPick, background = STAGE_BG, theme = 'dark' }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: background === null, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // the model is static: shadow maps are rendered once

  const scene = new THREE.Scene();
  scene.background = background === null ? null : new THREE.Color(background);

  const camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, 120);

  const { minX, minZ, maxX, maxZ } = config.bounds;
  const H = config.wallHeight;
  const center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const span = Math.max(maxX - minX, maxZ - minZ);

  const baseAz = config.camera.azimuth;
  const camDir = new THREE.Vector3(Math.sin(rad(baseAz)), 0, Math.cos(rad(baseAz)));

  /* ---------- content ---------- */

  const house = buildHouse(config, camDir);
  scene.add(house.group);
  const furniture = buildFurniture(config.furniture);
  scene.add(furniture);

  const lights = new Map();
  for (const cfg of config.lights) {
    const unit = new LightUnit(cfg, H);
    lights.set(cfg.id, unit);
    scene.add(unit.group);
  }
  const acs = new Map();
  for (const cfg of config.acs) {
    const unit = new ACUnit(cfg);
    acs.set(cfg.id, unit);
    scene.add(unit.group);
  }
  // Every TV piece shows the real TV it is linked to (tv/client.js), or stays dark.
  const tvs = furniture.userData.tvs.map((piece) => new TvUnit(piece, { anisotropy: renderer.capabilities.getMaxAnisotropy() }));
  const hitTargets = [...[...lights.values()].map((u) => u.hit), ...[...acs.values()].map((u) => u.hit),
    ...tvs.map((u) => u.hit), ...house.floors];

  // Night-time ambience: enough to read the model with every lamp off (or daylight, `setTheme`).
  const hemi = new THREE.HemisphereLight(0x8ea6ff, 0x0b0e17, 0.42);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0xa9c0ff, 0.6);
  // Steep and coming from the viewer's side, so the faces we look at stay readable.
  moon.position.copy(center).add(new THREE.Vector3(camDir.x * 3.2 + 1.5, 10, camDir.z * 3.2 - 1.5));
  moon.target.position.copy(center);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  const sc = moon.shadow.camera;
  sc.left = sc.bottom = -span * 0.85;
  sc.right = sc.top = span * 0.85;
  sc.near = 1;
  sc.far = 30;
  moon.shadow.bias = -0.0008;
  moon.shadow.normalBias = 0.04;
  moon.shadow.radius = 4;
  scene.add(moon, moon.target);

  /* ---------- post-processing ---------- */

  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.34, 0.5, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ---------- camera rig ---------- */

  const rig = {
    az: baseAz, el: config.camera.elevation, dist: 30, target: center.clone(), fov: FOV,
    goal: { az: baseAz, el: config.camera.elevation, dist: 30, target: center.clone(), fov: FOV },
    zoom: 1, focus: null,
    corners: [], // what the goal frames (world points), for the mini view
  };
  let width = 1;
  let height = 1;
  let topInset = 0;    // pixels at the top kept clear (the status bar), at rest
  let bottomInset = 0; // pixels at the bottom covered by the card, at rest
  // The strip the model shrinks into when the card is pulled up, and how far it is pulled.
  let mini = null;     // { top, bottom, side } in canvas pixels
  let sheet = 0;

  const v = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function basis(az, el) {
    const a = rad(az);
    const e = rad(el);
    fwd.set(-Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e));
    right.set(Math.cos(a), 0, -Math.sin(a));
    up.crossVectors(right, fwd);
  }

  // Smallest distance at which `box` fits the usable part of the viewport.
  function fitDistance(box, az, el, fill) {
    basis(az, el);
    const c = box.getCenter(new THREE.Vector3());
    const usableH = Math.max(0.3, (height - topInset - bottomInset) / height);
    const tanV = Math.tan(rad(rig.goal.fov / 2)) * fill * usableH;
    const tanH = Math.tan(rad(rig.goal.fov / 2)) * camera.aspect * fill;
    let dist = 0;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      const depth = v.dot(fwd);
      dist = Math.max(dist, Math.abs(v.dot(right)) / tanH - depth, Math.abs(v.dot(up)) / tanV - depth);
    }
    return { dist, center: c };
  }

  // Editing: the camera looks straight down at the whole floor (north up, like the plan).
  let topView = false;
  let tween = null; // a timed camera move: { from, t0, dur, resolve }

  function frameGoal() {
    const f = rig.focus;
    let box;
    let fill = 0.96;
    rig.goal.fov = FOV;
    if (f?.kind === 'tv' && tvOf(f.id) && !topView) { closeUp(tvOf(f.id)); return; }
    if (topView) {
      box = new THREE.Box3(new THREE.Vector3(minX, 0, minZ), new THREE.Vector3(maxX, 0.02, maxZ));
      fill = 0.9;
    } else if (f?.kind === 'room') {
      const r = config.rooms.find((x) => x.id === f.id);
      box = new THREE.Box3(new THREE.Vector3(r.x, 0, r.z), new THREE.Vector3(r.x + r.w, H * 0.75, r.z + r.d));
      fill = 0.84;
    } else if (f?.kind === 'ac') {
      const unit = acs.get(f.id);
      const p = unit.group.position;
      const out = new THREE.Vector3(0, 0, 1).applyQuaternion(unit.group.quaternion);
      box = new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(p.x + out.x * 1.3, 1.25, p.z + out.z * 1.3), new THREE.Vector3(3.6, 2.6, 3.6));
      fill = 0.92;
    } else {
      box = new THREE.Box3(new THREE.Vector3(minX, 0, minZ), new THREE.Vector3(maxX, H * 0.8, maxZ));
    }
    const { dist, center: c } = fitDistance(box, rig.goal.az, rig.goal.el, fill);
    rig.goal.dist = dist * rig.zoom;
    rig.goal.target.copy(c);
    rig.corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  }

  // Standing in front of the TV, eyes level with the middle of its screen, looking straight
  // at it: the field of view takes in the screen and a little around it, above the card.
  function closeUp(unit) {
    const { center: c, normal, w, h } = unit.face();
    const az = THREE.MathUtils.radToDeg(Math.atan2(normal.x, normal.z));
    const g = rig.goal;
    g.az = az + Math.round((rig.az - az) / 360) * 360; // the short way round
    g.el = 0;
    g.dist = TV_DIST;
    g.target.copy(c);
    const usableH = Math.max(40, height - topInset - bottomInset);
    const [bw, bh] = [w * TV_AROUND[0], h * TV_AROUND[1]];
    const tan = Math.max(bw * height / (2 * TV_DIST * width), bh * height / (2 * TV_DIST * usableH));
    g.fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(tan)), 20, 110);
    // The screen with the margin around it, for the mini view.
    const side = new THREE.Vector3(normal.z, 0, -normal.x);
    rig.corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => c.clone()
      .addScaledVector(side, (sx * bw) / 2).add(new THREE.Vector3(0, (sy * bh) / 2, 0)));
  }
  const closeUpOn = () => rig.focus?.kind === 'tv' && Boolean(tvOf(rig.focus.id)) && !topView;

  function placeCamera() {
    basis(rig.az, rig.el);
    camera.position.copy(rig.target).addScaledVector(fwd, -rig.dist);
    // Straight down, "up" is ambiguous: the screen's up is north (-z), as on the plan.
    if (rig.el > 80) camera.up.copy(up); else camera.up.set(0, 1, 0);
    camera.lookAt(rig.target);
    camera.updateMatrixWorld();
    // Close to the TV, whatever stands between the camera and its cabinet is cut away.
    const close = clamp((2 - rig.dist) / (2 - TV_DIST), 0, 1);
    const near = NEAR + Math.max(0, rig.dist - TV_CLEAR - NEAR) * close;
    if (camera.fov !== rig.fov || camera.near !== near) {
      camera.fov = rig.fov;
      camera.near = near;
      project();
    }
  }

  /* ---------- the card: full size above it, or shrunk into the strip over it ---------- */

  // The projection for the card's progress `sheet`: at 0 the model is framed above the card
  // at rest; at 1 it is the same picture, scaled and moved into the mini strip. In between,
  // both move in a straight line with the card, so the model's lower edge keeps pace with
  // the card's top. Only the projection changes: nothing is resized or rebuilt.
  const tmpCam = new THREE.PerspectiveCamera();
  function project() {
    camera.zoom = 1;
    camera.setViewOffset(width, height, 0, -(topInset - bottomInset) / 2, width, height);
    camera.updateProjectionMatrix();
    if (!(sheet > 0.0005) || !mini || !rig.corners.length) { crop(0); return; }
    // Where the goal's frame lies at rest (seen from where the camera is heading, so a
    // camera move plays out at the size it ends at).
    const g = rig.goal;
    basis(g.az, g.el);
    tmpCam.copy(camera);
    tmpCam.fov = g.fov;
    tmpCam.position.copy(g.target).addScaledVector(fwd, -g.dist);
    tmpCam.up.set(0, 1, 0);
    if (g.el > 80) tmpCam.up.copy(up);
    tmpCam.lookAt(g.target);
    tmpCam.updateMatrixWorld();
    tmpCam.updateProjectionMatrix();
    basis(rig.az, rig.el);
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const p of rig.corners) {
      v.copy(p).project(tmpCam);
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-v.y * 0.5 + 0.5) * height;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (!(x1 > x0 && y1 > y0)) { crop(0); return; }
    const mw = Math.max(10, width - mini.side * 2);
    const mh = Math.max(10, mini.bottom - mini.top);
    // In front of the TV the picture is cut to a small window in the strip (zoomed out
    // uncut, a wide view would bend at its edges): the screen fills most of its height.
    const tvness = clamp((2 - rig.dist) / (2 - TV_DIST), 0, 1);
    const fit = (mh * 0.94) / (y1 - y0);
    const scale = Math.min(1, (mw * 0.96) / (x1 - x0), fit + (fit * TV_MINI_FILL - fit) * tvness);
    const t = sheet;
    const s = 1 + (scale - 1) * t;
    // The frame's centre at rest (r) goes to the strip's centre (m); the axis (a0) follows.
    const rx = (x0 + x1) / 2;
    const ry = (y0 + y1) / 2;
    const cx = rx + (width / 2 - rx) * t;
    const cy = ry + ((mini.top + mini.bottom) / 2 - ry) * t;
    const a0y = height / 2 + (topInset - bottomInset) / 2;
    const ax = cx - s * (rx - width / 2);
    const ay = cy - s * (ry - a0y);
    camera.zoom = s;
    camera.setViewOffset(width, height, width / 2 - ax, height / 2 - ay, width, height);
    camera.updateProjectionMatrix();
    crop(t * tvness, mh);
  }

  // The close-up's window in the strip: from the whole canvas (k = 0) to a rounded window
  // twice as wide as the strip is tall, in its middle (k = 1).
  let cropped = '';
  function crop(k, mh = 0) {
    let next = '';
    if (k > 0.001 && mini) {
      const w = Math.min(width - mini.side * 2, mh * TV_MINI_ASPECT);
      const box = [mini.top, (width - w) / 2, height - mini.bottom, (width - w) / 2]; // top right bottom left
      const r = Math.round(16 * k);
      next = `inset(${box.map((b) => `${Math.round(b * k * 10) / 10}px`).join(' ')} round ${r}px)`;
    }
    if (next !== cropped) canvas.style.clipPath = cropped = next;
  }

  function updateRig(dt, instant = false) {
    const k = instant ? 1 : 1 - Math.exp(-dt * 5.5);
    const g = rig.goal;
    const delta = Math.abs(g.az - rig.az) + Math.abs(g.el - rig.el) + Math.abs(g.dist - rig.dist) * 2
      + rig.target.distanceTo(g.target) * 4 + Math.abs(g.fov - rig.fov);
    rig.az += (g.az - rig.az) * k;
    rig.el += (g.el - rig.el) * k;
    rig.dist += (g.dist - rig.dist) * k;
    rig.fov += (g.fov - rig.fov) * k;
    rig.target.lerp(g.target, k);
    placeCamera();
    return delta > 0.002;
  }

  // Eased in and out over a fixed time, so the editor knows when the camera lands. The
  // goal may still move meanwhile (the stage is growing): the camera heads for it anyway.
  function stepTween(now) {
    const p = clamp((now - tween.t0) / tween.dur, 0, 1);
    const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    const { from } = tween;
    const g = rig.goal;
    rig.az = from.az + (g.az - from.az) * e;
    rig.el = from.el + (g.el - from.el) * e;
    // Distance and field of view in proportion (log), so a fly-in neither lunges nor crawls.
    rig.dist = Math.exp(Math.log(from.dist) + (Math.log(g.dist) - Math.log(from.dist)) * e);
    rig.fov = from.fov + (g.fov - from.fov) * e;
    rig.target.copy(from.target).lerp(g.target, e);
    placeCamera();
    if (p >= 1) {
      const { resolve } = tween;
      tween = null;
      settleAzimuth();
      resolve();
    }
  }

  // Back at the usual view, the azimuth returns to its own range (the orbit is clamped around it).
  function settleAzimuth() {
    if (topView) return;
    const turns = Math.round((rig.az - baseAz) / 360) * 360;
    rig.az -= turns;
    rig.goal.az -= turns;
  }

  /* ---------- state sync ---------- */

  function syncAll(opts = {}) {
    let i = 0;
    for (const [id, unit] of lights) {
      unit.apply(store.state.lights[id], { ...opts, delay: opts.stagger ? 0.25 + i++ * 0.06 : 0 });
    }
    for (const [id, unit] of acs) unit.apply(store.state.acs[id], opts);
    wake();
  }

  function tvOf(id) {
    return id ? tvs.find((u) => u.id === id) : null;
  }

  function syncTvs(state, opts = {}) {
    const links = tvLinks(config.furniture, state);
    for (const unit of tvs) {
      unit.link(links.find((l) => l.index === unit.index)?.id ?? null);
      unit.apply(unit.id ? state.devices.find((d) => d.id === unit.id) : null, opts);
    }
    wake();
  }
  const unsubscribeTv = tvs.length ? tv.subscribe((state) => syncTvs(state)) : () => {};

  const unsubscribe = store.on((change) => {
    if (change.type === 'tick') return;
    if (change.type === 'light') lights.get(change.id).apply(store.state.lights[change.id]);
    else if (change.type === 'ac') acs.get(change.id).apply(store.state.acs[change.id]);
    else syncAll();
    wake();
  });

  /* ---------- picking ---------- */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovered = null;
  let drag = null;
  let sheetDown = 0; // the card's progress when the press began

  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // A TV piece that shows no real TV is only furniture.
    const hits = raycaster.intersectObjects(hitTargets, false).filter((h) => h.object.userData.kind !== 'tv' || h.object.userData.id);
    if (!hits.length) return null;
    // Devices win over the floor they stand on.
    const device = hits.find((h) => h.object.userData.kind !== 'room');
    return (device || hits[0]).object.userData;
  }

  function unitOf(t) {
    if (t?.kind === 'tv') return tvOf(t.id);
    return t?.kind === 'light' ? lights.get(t.id) : t?.kind === 'ac' ? acs.get(t.id) : null;
  }

  function screenAnchor(t) {
    const unit = unitOf(t);
    if (!unit) return null;
    unit.anchor(v).project(camera);
    return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height };
  }

  function setHover(t) {
    const same = hovered?.kind === t?.kind && hovered?.id === t?.id;
    if (same) return;
    const prev = unitOf(hovered);
    if (prev) prev.hoverGoal = 0;
    hovered = t && t.kind !== 'room' ? t : null;
    const next = unitOf(hovered);
    if (next) next.hoverGoal = 1;
    canvas.style.cursor = hovered ? 'pointer' : drag?.moved ? 'grabbing' : 'grab';
    onHover(hovered ? { ...hovered, ...screenAnchor(hovered) } : null);
    wake();
  }

  // Two fingers pinch to zoom, the way the scroll wheel does with a mouse.
  const fingers = new Map();
  let pinch = null;
  const spread = () => {
    const [a, b] = [...fingers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  };

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (fingers.size === 2) {
      pinch = { spread: spread(), zoom: rig.zoom };
      drag = null;
      setHover(null);
      return;
    }
    if (fingers.size > 2) return;
    drag = { x: ev.clientX, y: ev.clientY, az: rig.goal.az, el: rig.goal.el, moved: false };
    sheetDown = sheet;
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (fingers.has(ev.pointerId)) fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch) {
      if (fingers.size >= 2 && !closeUpOn()) {
        rig.zoom = clamp(pinch.zoom * pinch.spread / spread(), ZOOM_MIN, ZOOM_MAX);
        frameGoal();
        wake();
      }
      return;
    }
    if (drag) {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; setHover(null); canvas.style.cursor = 'grabbing'; }
      // In front of the TV the view stays put: only a tap means something there.
      if (drag.moved && !closeUpOn()) {
        rig.goal.az = clamp(drag.az - dx * 0.35, baseAz - ORBIT_AZ, baseAz + ORBIT_AZ);
        rig.goal.el = clamp(drag.el + dy * 0.3, EL_MIN, EL_MAX);
        frameGoal();
        wake();
      }
      return;
    }
    setHover(pick(ev));
  });
  const release = (ev) => {
    fingers.delete(ev.pointerId);
    if (pinch) { if (!fingers.size) pinch = null; return; } // lifting after a pinch picks nothing
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    canvas.style.cursor = 'grab';
    if (wasDrag) return;
    const t = pick(ev);
    // `mini`: the tap landed on the small view over the pulled-up card.
    const where = { mini: sheetDown > 0.5 };
    if (!t) { onPick(null, where); return; }
    if (t.kind === 'light') lights.get(t.id).bump();
    onPick(t, where);
    wake();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', (ev) => {
    fingers.delete(ev.pointerId);
    if (!fingers.size) pinch = null;
    drag = null;
  });
  canvas.addEventListener('pointerleave', () => { if (!drag) setHover(null); });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (closeUpOn()) return;
    rig.zoom = clamp(rig.zoom * Math.exp(ev.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    frameGoal();
    wake();
  }, { passive: false });
  canvas.style.cursor = 'grab';

  /* ---------- loop ---------- */

  let raf = 0;
  let last = 0;
  let awake = 0;       // frames still owed after the last change
  let running = false;
  let shadowFrames = 3;
  const hooks = new Set(); // run first in every frame (the card's spring): true for more frames

  let inFrame = false;
  function wake(frames = 2) {
    awake = Math.max(awake, frames);
    if (running && !raf && !inFrame) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  /* ---------- light and dark ---------- */

  const looks = Object.fromEntries(Object.entries(LOOKS).map(([k, l]) => [k, {
    ...l, bg: new THREE.Color(l.bg), sky: new THREE.Color(l.sky), ground: new THREE.Color(l.ground),
    sun: new THREE.Color(l.sun), plinth: new THREE.Color(l.plinth),
  }]));
  let lookT = theme === 'light' ? 1 : 0; // 0 dark … 1 light
  let lookGoal = lookT;
  const mix = (a, b, t, out) => out.copy(a).lerp(b, t);
  function applyLook() {
    const [a, b, t] = [looks.dark, looks.light, lookT * lookT * (3 - 2 * lookT)];
    if (scene.background) mix(a.bg, b.bg, t, scene.background);
    mix(a.sky, b.sky, t, hemi.color);
    mix(a.ground, b.ground, t, hemi.groundColor);
    hemi.intensity = a.hemi + (b.hemi - a.hemi) * t;
    mix(a.sun, b.sun, t, moon.color);
    moon.intensity = a.sunI + (b.sunI - a.sunI) * t;
    renderer.toneMappingExposure = a.exposure + (b.exposure - a.exposure) * t;
    mix(a.plinth, b.plinth, t, house.plinth.material.color);
    lookBloom = [a.bloom + (b.bloom - a.bloom) * t, a.threshold + (b.threshold - a.threshold) * t];
  }
  let lookBloom = [LOOKS.dark.bloom, LOOKS.dark.threshold];

  function stepLook(dt) {
    if (lookT === lookGoal) return false;
    const step = dt / THEME_FADE;
    lookT = lookGoal > lookT ? Math.min(lookGoal, lookT + step) : Math.max(lookGoal, lookT - step);
    applyLook();
    return true;
  }

  function frame(now) {
    raf = 0;
    inFrame = true;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let active = false;
    for (const hook of hooks) active = hook(now) || active;
    active = (tween ? (stepTween(now), true) : updateRig(dt)) || active;
    project();
    active = stepLook(dt) || active;
    // A lit screen seen from up close is read, not admired: the bloom steps back.
    const close = clamp((6 - rig.dist) / 4, 0, 1);
    bloom.strength = lookBloom[0] * (1 - close * 0.8);
    bloom.threshold = lookBloom[1];
    for (const unit of lights.values()) active = unit.update(dt) || active;
    for (const unit of acs.values()) active = unit.update(dt) || active;
    for (const unit of tvs) active = unit.update(dt) || active;
    if (shadowFrames > 0) { renderer.shadowMap.needsUpdate = true; shadowFrames--; active = true; }
    if (active || awake > 0) {
      composer.render(dt);
      awake = Math.max(0, awake - 1);
      if (hovered && active) onHover({ ...hovered, ...screenAnchor(hovered) });
    }
    inFrame = false;
    if (running && !raf && (active || awake > 0)) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    width = r.width;
    height = r.height;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(pr);
    composer.setSize(width, height);
    camera.aspect = width / height;
    frameGoal();
    // Centre the model between the top and the card by shifting the projection window.
    project();
    wake(3);
  }

  const world = {
    lights,
    acs,
    tvs,

    /** Pixels at the top and bottom of the canvas the model keeps clear of, at rest. */
    setInsets(top, bottom) { topInset = top; bottomInset = bottom; resize(); },
    resize,

    /** The strip ({ top, bottom, side }, canvas pixels) the model shrinks into over the pulled-up card. */
    setMini(strip) { mini = strip; wake(); },

    /**
     * How far the card is pulled up, 0 (rest) … 1 (expanded), a little beyond while it is
     * stretched. Applied in the next frame, the same one the card moves in (see `onFrame`).
     */
    setSheetProgress(p) {
      if (p === sheet) return;
      sheet = clamp(p, 0, 1.08);
      wake();
    },

    /** `fn(now)` runs first in every frame (true: it needs more); returns a remover. */
    onFrame(fn) { hooks.add(fn); wake(); return () => hooks.delete(fn); },
    wake,
    get running() { return running; },

    /** 'light' or 'dark': background and lighting blend there in about 300 ms. */
    setTheme(name, { instant = false } = {}) {
      lookGoal = name === 'light' ? 1 : 0;
      if (instant) { lookT = lookGoal; applyLook(); }
      wake(3);
    },

    focus(next) {
      const wasClose = closeUpOn();
      topView = false;
      rig.focus = next;
      rig.zoom = 1;
      rig.goal.az = baseAz + (next?.kind === 'ac' ? (WALL_SIDE[acs.get(next.id).cfg.wall] ?? 0) : 0);
      rig.goal.el = next?.kind === 'ac' ? 30 : config.camera.elevation;
      frameGoal();
      // Into the close-up in front of the TV, and back out of it, as one timed flight.
      if (wasClose !== closeUpOn() && running) fly(FLY);
      wake();
    },

    /**
     * Straight down at the whole home (on) or back to the plan's own view (off), as a timed
     * ease-in-out move. Resolves when the camera lands. `instant` jumps there.
     */
    topDown(on, { duration = 650, instant = false } = {}) {
      topView = on;
      rig.focus = null;
      rig.zoom = 1;
      // The shortest way round to north-up, and back.
      const turns = Math.round((rig.az - (on ? 0 : baseAz)) / 360) * 360;
      rig.goal.az = (on ? 0 : baseAz) + turns;
      rig.goal.el = on ? 89.5 : config.camera.elevation;
      frameGoal();
      if (instant || !running) {
        tween?.resolve();
        tween = null;
        updateRig(0, true);
        settleAzimuth();
        wake(3);
        return Promise.resolve();
      }
      return fly(duration);
    },

    /** Where a point of the floor (y = 0) is on the canvas, in CSS pixels. */
    projectFloor(x, z) {
      camera.updateMatrixWorld();
      v.set(x, 0, z).project(camera);
      return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height };
    },

    // Camera sweep + staggered light-up, played whenever the panel appears. `camera: false`
    // only lights the lamps (the editor's lift-off moves the camera itself). In front of the
    // TV the camera just stays there.
    intro({ camera: sweep = true } = {}) {
      syncAll({ instant: true });
      for (const unit of lights.values()) { unit.level = 0; unit.write(); }
      for (const unit of acs.values()) unit.power = 0;
      syncAll({ stagger: true });
      if (closeUpOn() && sweep) { frameGoal(); if (!tween) updateRig(0, true); wake(4); return; }
      if (!sweep) { wake(4); return; }
      frameGoal();
      rig.az = rig.goal.az - 16;
      rig.el = rig.goal.el + 9;
      rig.dist = rig.goal.dist * 1.28;
      rig.target.copy(rig.goal.target);
      wake(4);
    },

    setRunning(on) {
      running = on;
      if (on) wake(4);
      else {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        // A move that cannot play out lands at once.
        if (tween) { const { resolve } = tween; tween = null; updateRig(0, true); settleAzimuth(); resolve(); }
      }
    },

    dispose() {
      unsubscribe();
      unsubscribeTv();
      for (const unit of tvs) unit.dispose();
      tween?.resolve();
      tween = null;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      composer.dispose();
      target.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },

    // Jump every running animation to its end state (used by tests and screenshots).
    settle(seconds = 6) {
      if (tween) { const { resolve } = tween; tween = null; updateRig(0, true); settleAzimuth(); resolve(); }
      lookT = lookGoal;
      applyLook();
      for (let t = 0; t < seconds; t += 0.05) {
        updateRig(0.05);
        for (const unit of lights.values()) unit.update(0.05);
        for (const unit of acs.values()) unit.update(0.05);
        for (const unit of tvs) unit.update(0.05);
      }
      project();
      renderer.shadowMap.needsUpdate = true;
      composer.render(0);
    },
  };

  // A timed, eased camera move to wherever the goal is now (it may move on meanwhile).
  function fly(duration) {
    tween?.resolve();
    return new Promise((resolve) => {
      tween = { from: { az: rig.az, el: rig.el, dist: rig.dist, fov: rig.fov, target: rig.target.clone() }, t0: performance.now(), dur: duration, resolve };
      wake(3);
    });
  }

  applyLook();
  syncAll({ instant: true });
  if (tvs.length) syncTvs(tv.state, { instant: true });
  resize();
  updateRig(0, true);
  return world;
}

// Looking at an AC slightly from the side shows its airflow better.
const WALL_SIDE = { north: -14, west: 14, south: 0, east: 0 };

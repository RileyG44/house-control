// The TV's apps: the launcher's catalogue (hub/tv.py has the same ids and packages) and
// their logos, drawn here in the brands' colours: no image files. A logo is a few shapes
// on a 100 × 100 square, rendered as SVG for the launcher's tiles and onto a canvas for the
// TV screen in the 3D model, so both look the same.

// Shapes: ['path', d, fill] · ['stroke', d, colour, width, cap] · ['circle', cx, cy, r, fill]
//         ['text', string, x, y, size, fill, { weight, family, italic, spacing }]
const SANS = "-apple-system, 'SF Pro Display', 'Inter', 'Helvetica Neue', Arial, sans-serif";
const SERIF = "'Iowan Old Style', 'Palatino', Georgia, serif";

export const APPS = [
  {
    id: 'youtube', name: 'YouTube', package: 'com.google.android.youtube.tv', bg: '#0f0f0f', glow: '#ff0033',
    mark: [
      ['path', 'M22 34 C22 28 26 25 32 24.6 C40 24 60 24 68 24.6 C74 25 78 28 78 34 L78 66 C78 72 74 75 68 75.4 C60 76 40 76 32 75.4 C26 75 22 72 22 66 Z', '#ff0033'],
      ['path', 'M43 38 L62 50 L43 62 Z', '#ffffff'],
    ],
  },
  {
    id: 'netflix', name: 'Netflix', package: 'com.netflix.ninja', bg: '#000000', glow: '#e50914',
    mark: [
      ['path', 'M33 16 H45 V84 Q39 84.5 33 86 Z', '#b1060f'],
      ['path', 'M55 16 H67 V86 Q61 84.5 55 84 Z', '#b1060f'],
      ['path', 'M33 16 H45 L67 86 Q61 84.5 55 84 Z', '#e50914'],
    ],
  },
  {
    id: 'hulu', name: 'Hulu', package: 'com.hulu.livingroomplus', bg: '#040405', glow: '#1ce783',
    mark: [
      // h u l u, drawn with a pen 6.5 wide: square ends, round bowls.
      ['stroke', 'M19 35 V64 M19 52 C19 43.5 31 43.5 31 52 V64', '#1ce783', 6.5, 'butt'],
      ['stroke', 'M37 45 V56 C37 64.5 49 64.5 49 56 V45 M49 54 V64', '#1ce783', 6.5, 'butt'],
      ['stroke', 'M56 35 V64', '#1ce783', 6.5, 'butt'],
      ['stroke', 'M63 45 V56 C63 64.5 75 64.5 75 56 V45 M75 54 V64', '#1ce783', 6.5, 'butt'],
    ],
  },
  {
    id: 'prime', name: 'Prime Video', package: 'com.amazon.amazonvideo.livingroom', bg: ['#1a98ff', '#0a6ed1'], glow: '#1a98ff',
    mark: [
      ['text', 'prime', 50, 45, 25, '#ffffff', { weight: 800, spacing: -0.5 }],
      ['text', 'video', 50, 61, 15, '#ffffff', { weight: 600, spacing: 0.5 }],
      ['stroke', 'M29 67 Q50 76 69 67.5', '#ffffff', 2.8, 'round'],
      ['path', 'M65 64 L73.5 65.5 L69.5 72.5 Z', '#ffffff'],
    ],
  },
  {
    id: 'disney', name: 'Disney+', package: 'com.disney.disneyplus', bg: ['#0e1a4f', '#0a2a8f'], glow: '#2f6bff',
    mark: [
      ['stroke', 'M14 58 C26 30 70 26 88 46', '#9ec5ff', 2.4, 'round'],
      ['text', 'Disney', 42, 63, 23, '#ffffff', { weight: 700, family: SERIF, italic: true, spacing: -0.5 }],
      ['stroke', 'M81 51 V67 M73 59 H89', '#ffffff', 3.4, 'butt'],
    ],
  },
  {
    id: 'max', name: 'Max', package: 'com.wbd.stream', bg: ['#002be7', '#0018a8'], glow: '#2a4dff',
    mark: [['text', 'max', 50, 61, 34, '#ffffff', { weight: 900, spacing: -1.5 }]],
  },
  {
    id: 'peacock', name: 'Peacock', package: 'com.peacocktv.peacockandroid', bg: '#000000', glow: '#6e55dc',
    mark: [
      ['text', 'peacock', 44, 57, 16, '#ffffff', { weight: 800, spacing: -0.6 }],
      ...['#fccc12', '#f37c20', '#ef1541', '#6e55dc', '#069de0', '#05ac3f'].map((c, i) => ['circle', 84, 37 + i * 4.8, 1.9, c]),
    ],
  },
  {
    id: 'paramount', name: 'Paramount+', package: 'com.cbs.ott', bg: ['#0064ff', '#0040c8'], glow: '#2f7bff',
    mark: [
      ['path', 'M24 72 L42 46 L49 54 L55 47 L76 72 Z', '#ffffff'],
      ...[...Array(11)].map((_, i) => {
        const a = Math.PI * (1.08 + (i / 10) * 0.84);
        return ['circle', 50 + Math.cos(a) * 32, 60 + Math.sin(a) * 32, 2, '#ffffff'];
      }),
      ['stroke', 'M74 30 V40 M69 35 H79', '#ffffff', 2.4, 'butt'],
    ],
  },
  {
    id: 'appletv', name: 'Apple TV', package: 'com.apple.atve.androidtv.appletv', bg: '#000000', glow: '#9aa4b5',
    mark: [
      ['path', 'M32.5 40.5 C29 40.5 25 43.4 25 49.8 C25 57.6 30 66 33.6 66 C35.4 66 36.6 64.8 38.6 64.8 C40.6 64.8 41.6 66 43.6 66 C46.6 66 49.4 61 50.4 57.8 C47.4 56.4 45.8 53.8 45.8 50.8 C45.8 48 47.2 45.8 49.2 44.4 C47.6 42 45 40.6 42.4 40.6 C40 40.6 38.6 41.8 37.4 41.8 C36 41.8 34.6 40.5 32.5 40.5 Z', '#ffffff'],
      ['path', 'M37.6 39.4 C37.4 36.2 39.6 33.4 42.8 33 C43 36.2 40.6 39 37.6 39.4 Z', '#ffffff'],
      ['text', 'tv', 64, 64, 27, '#ffffff', { weight: 600, spacing: -0.5 }],
    ],
  },
  {
    id: 'tubi', name: 'Tubi', package: 'com.tubitv', bg: ['#7408ff', '#4a00b0'], glow: '#7408ff',
    mark: [['text', 'tubi', 50, 61, 33, '#ffff13', { weight: 900, spacing: -1 }]],
  },
  {
    id: 'pluto', name: 'Pluto TV', package: 'tv.pluto.android', bg: '#000000', glow: '#fff200',
    mark: [
      ['text', 'pluto', 40, 59, 21, '#ffffff', { weight: 800, spacing: -0.8 }],
      ['circle', 79, 52, 9.5, '#fff200'],
      ['text', 'tv', 79, 56, 10.5, '#000000', { weight: 900, spacing: -0.3 }],
    ],
  },
  {
    id: 'plex', name: 'Plex', package: 'com.plexapp.android', bg: '#1f2326', glow: '#e5a00d',
    mark: [['path', 'M37 24 H54 L72 50 L54 76 H37 L55 50 Z', '#e5a00d']],
  },
  {
    id: 'crunchyroll', name: 'Crunchyroll', package: 'com.crunchyroll.crunchyroid', bg: ['#ff7a2e', '#f2600c'], glow: '#f47521',
    mark: [
      ['circle', 48, 52, 25, '#ffffff'],
      ['circle', 55, 46, 16.5, '#f47521'],
      ['circle', 60, 42, 6.5, '#ffffff'],
    ],
  },
];

// What the TV shows when it is not in one of the apps above.
export const SYSTEM = {
  home: {
    id: 'home', name: 'Google TV', bg: ['#1b2232', '#0d1220'], glow: '#7aa2ff',
    mark: [
      ['stroke', 'M29 33 H71', '#4285f4', 6, 'round'],
      ['stroke', 'M71 33 Q77 33 77 39 V57 Q77 63 71 63', '#ea4335', 6, 'round'],
      ['stroke', 'M71 63 H29', '#fbbc04', 6, 'round'],
      ['stroke', 'M29 63 Q23 63 23 57 V39 Q23 33 29 33', '#34a853', 6, 'round'],
      ['stroke', 'M42 72 H58', '#9aa3b8', 4, 'round'],
    ],
  },
  ambient: {
    id: 'ambient', name: 'Ambient', bg: ['#3a2d6b', '#173a5e'], glow: '#7f73d9',
    mark: [
      ['circle', 62, 42, 13, 'rgba(255,214,170,0.85)'],
      ['path', 'M10 74 C28 60 40 66 52 62 C66 57 76 50 92 56 V92 H10 Z', 'rgba(20,24,52,0.55)'],
    ],
  },
  settings: {
    id: 'settings', name: 'Settings', bg: ['#2b3140', '#1b1f29'], glow: '#9aa4b5',
    mark: [
      ...[...Array(8)].map((_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return ['stroke', `M${50 + Math.cos(a) * 15} ${50 + Math.sin(a) * 15} L${50 + Math.cos(a) * 23} ${50 + Math.sin(a) * 23}`, '#dfe6f2', 8, 'butt'];
      }),
      ['circle', 50, 50, 17, '#dfe6f2'],
      ['circle', 50, 50, 7.5, '#262b38'],
    ],
  },
  other: {
    id: 'other', name: 'App', bg: ['#2b3140', '#151923'], glow: '#9aa4b5',
    mark: [['path', 'M42 36 L64 50 L42 64 Z', '#dfe6f2']],
  },
};

const BY_ID = new Map([...APPS, ...Object.values(SYSTEM)].map((a) => [a.id, a]));

/** The catalogue entry for an app as the TV reports it (`{ id, name, package }`), or null. */
export function appInfo(app) {
  if (!app) return null;
  const known = BY_ID.get(app.id);
  if (known && known.id !== 'other') return known;
  return { ...SYSTEM.other, name: app.name || 'App' };
}

/** The status line for a TV: "Netflix", "Google TV home", "Off", "Not reachable". */
export function statusOf(device, available = true) {
  if (!available || !device) return 'Not reachable';
  if (!device.online) return 'Not reachable';
  if (!device.on) return 'Off';
  if (!device.app) return 'On';
  if (device.app.id === 'home') return 'Google TV home';
  if (device.app.id === 'other') return 'On';
  return device.app.name;
}

/** A brand colour, as a CSS colour, for glows and tints. */
export const glowOf = (app) => appInfo(app)?.glow || '#7aa2ff';

/* ---------- SVG ---------- */

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
};
let gradients = 0;

/** The app's logo as an <svg> filling a square tile (its background included). */
export function logoSVG(app, size = 56, monochrome = false) {
  const a = app?.mark ? app : appInfo(app) || SYSTEM.other;
  const svg = svgEl('svg', { viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true', class: 'tv-logo' });
  let fill = monochrome ? '#f8f8f5' : a.bg;
  if (!monochrome && Array.isArray(a.bg)) {
    const id = `tvg${++gradients}`;
    const g = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 });
    g.append(svgEl('stop', { offset: 0, 'stop-color': a.bg[0] }), svgEl('stop', { offset: 1, 'stop-color': a.bg[1] }));
    const defs = svgEl('defs', {});
    defs.append(g);
    svg.append(defs);
    fill = `url(#${id})`;
  }
  svg.append(svgEl('rect', { width: 100, height: 100, fill }));
  const mark = svgEl('g', monochrome ? { transform: 'translate(9 9) scale(.82)' } : {});
  for (const s of a.mark) {
    const shape = svgShape(s);
    if (monochrome) {
      const key = s[0] === 'stroke' ? 'stroke' : 'fill';
      const color = shape.getAttribute(key);
      shape.setAttribute(key, (a.id === 'youtube' && color === '#ffffff') || color === '#000000' ? '#f8f8f5' : '#252624');
    }
    mark.append(shape);
  }
  svg.append(mark);
  return svg;
}

function svgShape([kind, ...p]) {
  if (kind === 'path') return svgEl('path', { d: p[0], fill: p[1] });
  if (kind === 'stroke') return svgEl('path', { d: p[0], fill: 'none', stroke: p[1], 'stroke-width': p[2], 'stroke-linecap': p[3] || 'butt', 'stroke-linejoin': 'round' });
  if (kind === 'circle') return svgEl('circle', { cx: p[0], cy: p[1], r: p[2], fill: p[3] });
  const [text, x, y, size, color, o = {}] = p;
  const t = svgEl('text', {
    x, y, fill: color, 'font-size': size, 'font-weight': o.weight || 700, 'font-family': o.family || SANS,
    'font-style': o.italic ? 'italic' : null, 'letter-spacing': o.spacing ?? null, 'text-anchor': 'middle',
  });
  t.textContent = text;
  return t;
}

/* ---------- canvas ---------- */

/** Fills the whole canvas with the app's background. */
export function paintBackground(ctx, app, w, h) {
  const a = app?.mark ? app : appInfo(app) || SYSTEM.other;
  if (Array.isArray(a.bg)) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, a.bg[0]);
    g.addColorStop(1, a.bg[1]);
    ctx.fillStyle = g;
  } else ctx.fillStyle = a.bg;
  ctx.fillRect(0, 0, w, h);
}

/** Draws the logo's shapes, its 100-unit square scaled to `size` px and centred on (cx, cy). */
export function paintMark(ctx, app, cx, cy, size) {
  const a = app?.mark ? app : appInfo(app) || SYSTEM.other;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 100, size / 100);
  for (const [kind, ...p] of a.mark) {
    if (kind === 'path') { ctx.fillStyle = p[1]; ctx.fill(new Path2D(p[0])); }
    else if (kind === 'stroke') {
      ctx.strokeStyle = p[1]; ctx.lineWidth = p[2]; ctx.lineCap = p[3] || 'butt'; ctx.lineJoin = 'round';
      ctx.stroke(new Path2D(p[0]));
    } else if (kind === 'circle') {
      ctx.fillStyle = p[3];
      ctx.beginPath(); ctx.arc(p[0], p[1], p[2], 0, Math.PI * 2); ctx.fill();
    } else {
      const [text, x, y, sz, color, o = {}] = p;
      ctx.fillStyle = color;
      ctx.font = `${o.italic ? 'italic ' : ''}${o.weight || 700} ${sz}px ${o.family || SANS}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${o.spacing || 0}px`;
      ctx.fillText(text, x, y);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
  }
  ctx.restore();
}

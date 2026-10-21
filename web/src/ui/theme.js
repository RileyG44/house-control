// The panel's light and dark looks. The card's sun / moon button cycles Auto → Light → Dark;
// Auto follows the system (`prefers-color-scheme`). The choice is kept on this device, and
// index.html applies it before the first paint, so a page never flashes the other look.
// Colours are the custom properties of `:root[data-theme=…]` in style.css; the 3D scene
// follows through `onTheme`.
import { post } from '../bridge.js';

export const THEMES = ['auto', 'light', 'dark'];
const KEY = 'house.theme';
const FADE = 260; // ms the colours take to change over

const system = matchMedia('(prefers-color-scheme: light)');
const listeners = new Set();

function saved() {
  try {
    const v = new URLSearchParams(location.search).get('theme') || localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'auto';
  } catch { return 'auto'; }
}

let choice = saved();

/** 'light' or 'dark': what `choice` looks like here and now. */
export function resolved(c = choice) {
  return c === 'auto' ? (system.matches ? 'light' : 'dark') : c;
}

/** The choice: 'auto', 'light' or 'dark'. */
export const themeChoice = () => choice;

function apply({ animate }) {
  const root = document.documentElement;
  const look = resolved();
  if (root.dataset.theme === look && root.dataset.themeChoice === choice) return;
  // Every colour eases over to the other look (and only during the change, so nothing
  // else picks up a slower transition).
  if (animate && root.dataset.theme && root.dataset.theme !== look && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theming');
    clearTimeout(apply.timer);
    apply.timer = setTimeout(() => root.classList.remove('theming'), FADE + 60);
  }
  root.dataset.theme = look;
  root.dataset.themeChoice = choice;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', look);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', look === 'light' ? '#f1ece4' : '#0a0e1a');
  // The Mac and iPhone apps match their window (and the iPhone's status bar) to it.
  post('theme', { theme: choice, look });
  for (const fn of listeners) fn(look, choice);
}

let started = false;

/** Starts following the saved choice (and the system, for Auto). Once per page. */
export function initTheme() {
  if (started) return;
  started = true;
  apply({ animate: false });
  system.addEventListener('change', () => { if (choice === 'auto') apply({ animate: true }); });
}

/** The next look in the cycle; returns the new choice. */
export function cycleTheme() {
  return setTheme(THEMES[(THEMES.indexOf(choice) + 1) % THEMES.length]);
}

export function setTheme(next) {
  if (!THEMES.includes(next)) return choice;
  choice = next;
  try { localStorage.setItem(KEY, choice); } catch { /* private browsing: this page only */ }
  apply({ animate: true });
  return choice;
}

/** `fn(look, choice)` on every change; returns a remover. */
export function onTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

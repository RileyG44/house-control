// iOS-style grouped lists for the editor's pages: rows, steppers, switches, segmented
// controls, chip grids, an action sheet and a snackbar. Every control that holds a value
// carries a `data-key`, so a page re-rendered after a change keeps the field being typed in.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { haptic } from '../bridge.js';

/** A titled block of rows with an optional footer line. */
export function group(title, rows, footer = null) {
  const list = [rows].flat(Infinity).filter(Boolean);
  if (!list.length && !footer) return null;
  return h('section.ed-group',
    title ? h('h3.ed-group-title', title) : null,
    list.length ? h('div.ed-list', list) : null,
    footer ? h('p.ed-group-foot', footer) : null);
}

/** An icon on a rounded tile, tinted. */
export function tile(name, tint = null, size = 28) {
  const el = h('span.ed-tile', { vars: { '--tint': tint || 'rgba(255,255,255,.14)', '--size': `${size}px` } });
  el.append(typeof name === 'string' ? icon(name, Math.round(size * 0.58), 2) : name);
  return el;
}

export function row({ icon: ic, tint, lead, title, subtitle, value, chevron, check, onClick, destructive, disabled, accessory, key, cls = '' }) {
  const tag = onClick && !disabled ? 'button' : 'div';
  const el = h(`${tag}.ed-row${destructive ? '.destructive' : ''}${disabled ? '.disabled' : ''}${cls ? `.${cls}` : ''}`, {
    type: tag === 'button' ? 'button' : null,
    'data-key': key,
    onclick: onClick && !disabled ? (ev) => { haptic('light'); onClick(ev); } : null,
  },
  lead || (ic ? tile(ic, tint) : null),
  h('span.ed-row-text', h('span.ed-row-title', title), subtitle ? h('span.ed-row-sub', subtitle) : null),
  value != null ? h('span.ed-row-value', value) : null,
  accessory || null,
  check ? h('span.ed-row-check', icon('check', 18, 2.6)) : null,
  chevron ? h('span.ed-row-chevron', icon('next', 17, 2.2)) : null);
  if (disabled) el.setAttribute('aria-disabled', 'true');
  return el;
}

/** A labelled text field. `onInput` runs per keystroke (the editor folds a burst into one undo step). */
export function textRow({ label, value, placeholder, onInput, onCommit, key, type = 'text', autofocus = false }) {
  const input = h('input.ed-input', {
    type, value: value ?? '', placeholder, spellcheck: 'false', autocomplete: 'off', 'data-key': key, enterkeyhint: 'done',
    'aria-label': label || placeholder,
  });
  input.addEventListener('input', () => onInput?.(input.value));
  input.addEventListener('change', () => onCommit?.(input.value));
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); ev.stopPropagation(); });
  if (autofocus) requestAnimationFrame(() => { input.focus(); input.select(); });
  return h('label.ed-row.ed-text-row', label ? h('span.ed-row-title', label) : null, input);
}

export function toggle({ value, onChange, disabled, label }) {
  const el = h(`button.ed-switch${value ? '.on' : ''}`, {
    type: 'button', role: 'switch', 'aria-checked': String(Boolean(value)), 'aria-label': label, disabled,
    onclick: (ev) => { ev.stopPropagation(); haptic('light'); onChange(!value); },
  });
  return el;
}

export function toggleRow({ icon: ic, tint, title, subtitle, value, onChange, disabled, key }) {
  const sw = toggle({ value, onChange, disabled, label: title });
  return h(`div.ed-row${disabled ? '.disabled' : ''}`, { 'data-key': key, onclick: () => !disabled && sw.click() },
    ic ? tile(ic, tint) : null,
    h('span.ed-row-text', h('span.ed-row-title', title), subtitle ? h('span.ed-row-sub', subtitle) : null),
    sw);
}

// While a stepper is held the page must not be redrawn under the finger: the editor asks
// `holding()` and redraws once `afterHold` runs.
let held = 0;
export const holding = () => held > 0;
export const hooks = { afterHold: null };

// Press and hold repeats, faster the longer it is held, like UIStepper.
function repeater(button, fire) {
  let timer = 0;
  let count = 0;
  let down = false;
  const stop = () => {
    clearTimeout(timer);
    timer = 0;
    if (!down) return;
    down = false;
    held = Math.max(0, held - 1);
    if (!held) hooks.afterHold?.();
  };
  const tick = () => {
    count++;
    if (!button.isConnected || fire() === false) { stop(); return; }
    timer = setTimeout(tick, count > 8 ? 55 : 110);
  };
  button.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || button.disabled) return;
    ev.preventDefault();
    count = 0;
    down = true;
    held++;
    fire();
    timer = setTimeout(tick, 420);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, stop);
  // Keyboard: Enter/Space click once.
  button.addEventListener('click', (ev) => { if (ev.detail === 0) fire(); });
}

/**
 * A value with − and + buttons. `step(value, dir)` returns the next value (so units can
 * step on their own grid); `onChange(next)` stores it. `auto` shows a state with no value.
 */
export function stepper({ value, format, step, min = -Infinity, max = Infinity, onChange, label, key, auto = null }) {
  let current = value;
  const shown = h('span.ed-stepper-value', current == null && auto ? auto.label : format(current));
  const next = (dir) => {
    const base = current == null ? (auto?.from ?? min) : current;
    const v = typeof step === 'function' ? step(base, dir) : base + dir * step;
    return Math.min(max, Math.max(min, v));
  };
  const minus = h('button.ed-stepper-btn', { type: 'button', 'aria-label': `Less ${label || ''}`.trim() }, icon('minus', 16, 2.4));
  const plus = h('button.ed-stepper-btn', { type: 'button', 'aria-label': `More ${label || ''}`.trim() }, icon('plus', 16, 2.4));
  const sync = () => {
    shown.textContent = current == null && auto ? auto.label : format(current);
    minus.disabled = current != null && current <= min + 1e-9;
    plus.disabled = current != null && current >= max - 1e-9;
  };
  const fire = (dir) => () => {
    const v = next(dir);
    if (current != null && Math.abs(v - current) < 1e-9) return false;
    current = v;
    haptic('tick');
    sync();
    onChange(v);
    return true;
  };
  repeater(minus, fire(-1));
  repeater(plus, fire(1));
  sync();
  return h('span.ed-stepper', { 'data-key': key }, shown, h('span.ed-stepper-btns', minus, h('i'), plus));
}

export function stepperRow({ icon: ic, tint, title, subtitle, ...opts }) {
  return h('div.ed-row.ed-stepper-row', ic ? tile(ic, tint) : null,
    h('span.ed-row-text', h('span.ed-row-title', title), subtitle ? h('span.ed-row-sub', subtitle) : null),
    stepper({ label: title, ...opts }));
}

/** iOS segmented control: options [{ value, label, icon? }]. */
export function segmented({ options, value, onChange, label, key, small = false }) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const thumb = h('span.ed-seg-thumb');
  const el = h(`div.ed-seg${small ? '.small' : ''}`, { role: 'radiogroup', 'aria-label': label, 'data-key': key, vars: { '--n': options.length, '--i': index } },
    thumb,
    options.map((o, i) => h(`button.ed-seg-opt${i === index && options[index].value === value ? '.on' : ''}`, {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === value), 'aria-label': o.aria || o.label,
      onclick: (ev) => {
        ev.stopPropagation();
        if (o.value === value) return;
        haptic('light');
        el.style.setProperty('--i', i);
        el.querySelectorAll('.ed-seg-opt').forEach((b, j) => b.classList.toggle('on', j === i));
        onChange(o.value);
      },
    }, o.icon ? icon(o.icon, 15, 2) : null, o.label ? h('span', o.label) : null)));
  if (!options.some((o) => o.value === value)) el.classList.add('none');
  return el;
}

export function segmentedRow({ icon: ic, tint, title, subtitle, ...opts }) {
  return h('div.ed-row.ed-seg-row', ic ? tile(ic, tint) : null,
    title ? h('span.ed-row-text', h('span.ed-row-title', title), subtitle ? h('span.ed-row-sub', subtitle) : null) : null,
    segmented({ label: title, ...opts }));
}

/** Tiles with an icon (or a drawing) and a label; the chosen one is marked. */
export function chipGrid({ items, value, onPick, columns = 3, key, size = 'normal' }) {
  return h(`div.ed-chips.${size}`, { 'data-key': key, vars: { '--cols': columns } },
    items.map((it) => h(`button.ed-chip${it.value === value ? '.on' : ''}${it.disabled ? '.disabled' : ''}`, {
      type: 'button', 'aria-pressed': String(it.value === value), 'aria-label': it.aria || it.label, disabled: it.disabled,
      onclick: () => { haptic('light'); onPick(it.value, it); },
    },
    h('span.ed-chip-art', it.glyph || (it.icon ? icon(it.icon, it.iconSize || 22, 1.8) : null)),
    h('span.ed-chip-label', it.label),
    it.sub ? h('span.ed-chip-sub', it.sub) : null)));
}

export function swatches({ colors, value, onPick, allowDefault = true, key, labels = {} }) {
  const pick = (c) => () => { haptic('light'); onPick(c); };
  return h('div.ed-swatches', { 'data-key': key },
    allowDefault ? h(`button.ed-swatch.default${!value ? '.on' : ''}`, { type: 'button', 'aria-label': 'Default colour', onclick: pick(null) }, h('span', 'Auto')) : null,
    colors.map((c) => h(`button.ed-swatch${value?.toLowerCase() === c.toLowerCase() ? '.on' : ''}`, {
      type: 'button', 'aria-label': labels[c] || `Colour ${c}`, vars: { '--sw': c }, onclick: pick(c),
    }, labels[c] ? h('span', labels[c]) : null)));
}

export function button({ label, icon: ic, style = 'plain', onClick, disabled, wide = false, busy = false, small = false }) {
  return h(`button.ed-btn.${style}${wide ? '.wide' : ''}${small ? '.small' : ''}${busy ? '.busy' : ''}`, {
    type: 'button', disabled: disabled || busy, onclick: (ev) => { haptic('light'); onClick?.(ev); },
  }, busy ? icon('spinner', 16, 2.2) : ic ? icon(ic, 16, 2.2) : null, label ? h('span', label) : null);
}

export function note(text, { tone = '', icon: ic = null } = {}) {
  return h(`p.ed-note${tone ? `.${tone}` : ''}`, ic ? icon(ic, 15, 2) : null, h('span', text));
}

/** Round buttons with labels under them (the share sheet's action row). */
export function quickActions(actions) {
  const list = actions.filter(Boolean);
  if (!list.length) return null;
  return h('div.ed-actions', list.map((a) => h(`button.ed-action${a.destructive ? '.destructive' : ''}${a.primary ? '.primary' : ''}${a.on ? '.on' : ''}`, {
    type: 'button', disabled: a.disabled, 'aria-label': a.label, vars: a.glow ? { '--glow': a.glow } : null,
    onclick: () => { haptic(a.haptic || 'light'); a.onClick(); },
  }, h('span.ed-action-icon', icon(a.icon, 22, 2)), h('span.ed-action-label', a.label))));
}

/* ---------- overlays ---------- */

/** iOS action sheet: a question with its choices, and Cancel. Resolves with the chosen index or -1. */
export function actionSheet(host, { title, message, actions, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    const close = (i) => {
      el.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => el.remove(), 260);
      resolve(i);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(-1); } };
    const el = h('div.ed-action-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (ev) => { if (ev.target === el) close(-1); } },
      h('div.ed-as-panel',
        h('div.ed-as-group',
          title || message ? h('div.ed-as-head', title ? h('b', title) : null, message ? [message].flat().map((m) => h('span', m)) : null) : null,
          actions.map((a, i) => h(`button.ed-as-btn${a.destructive ? '.destructive' : ''}`, { type: 'button', onclick: () => { haptic(a.destructive ? 'medium' : 'light'); close(i); } }, a.label))),
        h('button.ed-as-btn.cancel', { type: 'button', onclick: () => close(-1) }, cancel)));
    host.append(el);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
    setTimeout(() => el.querySelector('.ed-as-btn')?.focus({ preventScroll: true }), 30);
  });
}

/** A snackbar: a line of text and an optional action ("Undo"), for a few seconds. */
export function createToaster(host) {
  const el = h('div.ed-toast', { role: 'status', 'aria-live': 'polite' });
  host.append(el);
  let timer = 0;
  const hide = () => { el.classList.remove('show'); clearTimeout(timer); };
  return {
    el,
    hide,
    show(text, { action = null, tone = '', duration = action ? 5000 : 2600 } = {}) {
      clearTimeout(timer);
      el.className = `ed-toast${tone ? ` ${tone}` : ''}`;
      el.replaceChildren(h('span.ed-toast-text', text));
      if (action) el.append(h('button.ed-toast-action', { type: 'button', onclick: () => { hide(); haptic('light'); action.onClick(); } }, action.label));
      void el.offsetWidth;
      el.classList.add('show');
      timer = setTimeout(hide, duration);
    },
  };
}

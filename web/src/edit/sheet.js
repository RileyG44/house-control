// The container of the editor's pages. Narrow (the widget, a phone): an iOS bottom sheet
// with three detents (peek shows the page's summary, medium about half, large up to the top
// bar) that follows a finger and snaps with a flick. Wide (a desktop window): a card docked
// on the right. Both hold the same stack of pages, pushed and popped like a UINavigationController.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { haptic } from '../bridge.js';

const PUSH_MS = 350;
const SNAP = 'transform 480ms cubic-bezier(0.32, 0.72, 0, 1)';

export function createSheet({ onChange, onClose }) {
  const grabber = h('div.ed-grabber', { 'aria-hidden': 'true' }, h('span'));
  const pages = h('div.ed-pages');
  const el = h('section.ed-sheet', { 'aria-label': 'Details' }, grabber, pages);

  let layout = 'narrow';
  let geo = { height: 600, top: 60, safeBottom: 0 }; // container height, bottom of the top bar
  let detent = 'peek';
  let visible = 0;
  let peekH = 160;
  const stack = []; // { page, el, scroll }

  /* ---------- pages ---------- */

  function build(entry, index) {
    const { page } = entry;
    const out = page.render();
    const prev = stack[index - 1]?.page;
    const back = index > 0 && page.kind !== 'item'
      ? h('button.ed-back', { type: 'button', onclick: () => pop() }, icon('back', 20, 2.4), h('span', prev?.short || 'Back'))
      : null;
    const close = page.kind === 'item' || page.close
      ? h('button.ed-close', { type: 'button', 'aria-label': page.closeLabel || 'Close', onclick: () => onClose(page) }, icon('close', 15, 2.6))
      : null;
    const head = out.head;
    const node = h(`div.ed-page${page.kind === 'root' ? '.root' : ''}`, { 'data-page': page.key },
      back ? h('div.ed-page-nav', back) : null,
      head ? h('div.ed-page-head',
        head.tile || null,
        h('div.ed-page-titles', h('div.ed-page-title', head.title), head.subtitle ? h('div.ed-page-sub', head.subtitle) : null),
        head.accessory || null,
        close) : null,
      h('div.ed-page-scroll',
        h('div.ed-summary', out.actions || null, out.extra || null),
        h('div.ed-page-body', out.body)));
    attachDrag(node);
    return node;
  }

  function current() { return stack[stack.length - 1]; }

  // A page that opens scrolled somewhere (Add, at the devices found) does it once laid out.
  function afterRender(entry) {
    if (!entry.page.afterRender) return;
    requestAnimationFrame(() => { if (entry.el?.isConnected) entry.page.afterRender(entry.el); });
  }

  // Replaces the whole stack (a new selection): no slide, a quick cross-fade.
  function show(list, { animate = 'fade', detent: want = null } = {}) {
    const old = [...pages.children];
    stack.length = 0;
    list.forEach((page) => stack.push({ page, el: null, scroll: 0 }));
    const top = current();
    top.el = build(top, stack.length - 1);
    pages.append(top.el);
    afterRender(top);
    if (animate === 'push' || animate === 'pop') slide(old, top.el, animate);
    else if (animate === 'fade' && old.length) {
      top.el.classList.add('fade-in');
      for (const o of old) { o.classList.add('fade-out'); setTimeout(() => o.remove(), 200); }
    } else old.forEach((o) => o.remove());
    settle(want);
  }

  function push(page, { detent: want = null } = {}) {
    const prev = current();
    if (prev) prev.scroll = scrollerOf(prev.el)?.scrollTop || 0;
    const entry = { page, el: null, scroll: 0 };
    stack.push(entry);
    entry.el = build(entry, stack.length - 1);
    pages.append(entry.el);
    afterRender(entry);
    slide(prev ? [prev.el] : [], entry.el, 'push');
    // A page pushed from the peek opens at medium; some want large.
    settle(want || page.detent || (detent === 'peek' ? 'medium' : null));
  }

  function pop() {
    if (stack.length < 2) return false;
    const gone = stack.pop();
    gone.page.onLeave?.();
    const top = current();
    top.el = build(top, stack.length - 1);
    pages.append(top.el);
    const sc = scrollerOf(top.el);
    if (sc) sc.scrollTop = top.scroll;
    slide([gone.el], top.el, 'pop');
    haptic('light');
    settle(null);
    return true;
  }

  function slide(olds, next, dir) {
    next.classList.add(dir === 'push' ? 'enter-right' : 'enter-left');
    void next.offsetWidth;
    next.classList.add('sliding');
    next.classList.remove('enter-right', 'enter-left');
    for (const o of olds) {
      o.classList.add('sliding', dir === 'push' ? 'leave-left' : 'leave-right');
      o.inert = true;
      setTimeout(() => o.remove(), PUSH_MS + 30);
    }
    setTimeout(() => next.classList.remove('sliding'), PUSH_MS + 30);
  }

  const scrollerOf = (node) => node?.querySelector('.ed-page-scroll');

  // Re-renders the top page in place: same scroll position, same field focused, same caret.
  function refresh() {
    const top = current();
    if (!top?.el) return;
    const old = top.el;
    const sc = scrollerOf(old);
    const scroll = sc?.scrollTop || 0;
    const active = old.contains(document.activeElement) ? document.activeElement : null;
    const key = active?.dataset?.key || active?.closest('[data-key]')?.dataset.key;
    const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const next = build(top, stack.length - 1);
    next.className = old.className.replace(/\b(fade-in|enter-right|enter-left)\b/g, '');
    old.replaceWith(next);
    top.el = next;
    const nsc = scrollerOf(next);
    if (nsc) nsc.scrollTop = scroll;
    if (key) {
      const target = next.querySelector(`[data-key="${CSS.escape(key)}"]`);
      const field = target?.matches('input, textarea, button') ? target : target?.querySelector('input, textarea');
      if (field) {
        field.focus({ preventScroll: true });
        try { if (caret) field.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
      }
    }
    if (detent === 'peek') measurePeek(true);
  }

  /* ---------- detents ---------- */

  const heights = () => ({
    peek: peekH,
    medium: Math.round(Math.max(peekH + 60, geo.height * 0.52)),
    large: Math.max(peekH + 80, Math.round(geo.height - geo.top - 8)),
  });

  function measurePeek(apply = false) {
    const top = current()?.el;
    if (!top || layout !== 'narrow') return;
    const body = top.querySelector('.ed-page-body');
    const sheetTop = el.getBoundingClientRect().top;
    const bodyTop = body ? body.getBoundingClientRect().top : sheetTop + 160;
    const sc = scrollerOf(top);
    const scrolled = sc ? sc.scrollTop : 0;
    const measured = bodyTop - sheetTop + scrolled + 6 + geo.safeBottom;
    peekH = Math.round(Math.min(Math.max(measured, 110 + geo.safeBottom), 270 + geo.safeBottom));
    if (apply && detent === 'peek') place(heights().peek, true);
  }

  function place(h0, animate) {
    const hs = heights();
    visible = Math.round(h0);
    el.style.height = `${hs.large}px`;
    el.style.transition = animate ? SNAP : 'none';
    el.style.transform = `translateY(${hs.large - visible}px)`;
    el.dataset.detent = detent;
    onChange?.({ visible: Math.min(visible, hs.large), detent, layout, animate });
  }

  function setDetent(name, { animate = true } = {}) {
    if (layout !== 'narrow') return;
    if (name !== detent) haptic('light');
    detent = name;
    const sc = scrollerOf(current()?.el);
    // At the peek only the summary shows: back to the top of the page.
    if (name === 'peek' && sc) sc.scrollTop = 0;
    el.classList.toggle('scroll-locked', name === 'peek');
    place(heights()[name], animate);
  }

  function settle(want) {
    if (layout !== 'narrow') { onChange?.({ visible: 0, detent, layout, animate: true }); return; }
    requestAnimationFrame(() => {
      measurePeek();
      setDetent(want || detent);
    });
  }

  /* ---------- dragging the sheet ---------- */

  let drag = null;
  const begin = (y) => {
    drag = { y0: y, h0: visible, samples: [[performance.now(), y]] };
    el.style.transition = 'none';
    el.classList.add('dragging');
  };
  const follow = (y) => {
    const hs = heights();
    let next = drag.h0 - (y - drag.y0);
    // Rubber band past the ends.
    if (next > hs.large) next = hs.large + (next - hs.large) * 0.25;
    if (next < hs.peek) next = hs.peek - (hs.peek - next) * 0.35;
    visible = next;
    el.style.transform = `translateY(${hs.large - next}px)`;
    drag.samples.push([performance.now(), y]);
    if (drag.samples.length > 6) drag.samples.shift();
    onChange?.({ visible: Math.max(0, Math.min(next, hs.large)), detent, layout, animate: false });
  };
  const end = () => {
    const s = drag.samples;
    const [t0, y0] = s[0];
    const [t1, y1] = s[s.length - 1];
    const v = t1 - t0 > 0 ? (y0 - y1) / (t1 - t0) : 0; // px per ms, upwards positive
    drag = null;
    el.classList.remove('dragging');
    const hs = heights();
    const projected = visible + v * 160;
    const order = ['peek', 'medium', 'large'];
    let best = order.reduce((a, b) => (Math.abs(hs[b] - projected) < Math.abs(hs[a] - projected) ? b : a));
    // A flick always goes at least one detent in its direction.
    const i = order.indexOf(detent);
    if (Math.abs(v) > 0.45 && best === detent) best = order[Math.max(0, Math.min(2, i + (v > 0 ? 1 : -1)))];
    setDetent(best);
  };

  function attachDrag(node) {
    // The grabber row and the page's header move the sheet (mouse, pen or finger).
    const handle = (ev) => ev.target.closest('.ed-page-head, .ed-page-nav') && !ev.target.closest('button, input, a, [role="switch"]');
    node.addEventListener('pointerdown', (ev) => {
      if (layout !== 'narrow' || !handle(ev) || ev.button !== 0) return;
      startPointer(ev);
    });
    // Content scrolled to its top: pulling down moves the sheet, as on iOS. Touch events,
    // because pointer events are cancelled the moment the browser starts scrolling.
    const sc = scrollerOf(node);
    if (!sc) return;
    let t = null;
    sc.addEventListener('touchstart', (ev) => {
      if (layout !== 'narrow' || ev.touches.length !== 1) { t = null; return; }
      t = { y: ev.touches[0].clientY, x: ev.touches[0].clientX, active: false, decided: false };
    }, { passive: true });
    sc.addEventListener('touchmove', (ev) => {
      if (!t) return;
      const y = ev.touches[0].clientY;
      const dy = y - t.y;
      if (!t.decided) {
        if (Math.abs(dy) < 6 && Math.abs(ev.touches[0].clientX - t.x) < 6) return;
        t.decided = true;
        const atTop = sc.scrollTop <= 0;
        const vertical = Math.abs(dy) > Math.abs(ev.touches[0].clientX - t.x);
        // Down from the top of the content, or any vertical pull while not at large.
        t.active = vertical && ((atTop && dy > 0) || detent !== 'large') && !ev.target.closest('input, [role="slider"]');
        if (t.active) begin(y);
      }
      if (t.active) { ev.preventDefault(); follow(y); }
    }, { passive: false });
    const done = () => { if (t?.active && drag) end(); t = null; };
    sc.addEventListener('touchend', done);
    sc.addEventListener('touchcancel', done);
  }

  function startPointer(ev) {
    const id = ev.pointerId;
    const y0 = ev.clientY;
    let moved = false;
    const move = (e) => {
      if (e.pointerId !== id) return;
      if (!moved && Math.abs(e.clientY - y0) < 4) return;
      if (!moved) { moved = true; begin(y0); }
      follow(e.clientY);
    };
    const up = (e) => {
      if (e.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (moved && drag) end();
      else if (!moved && e.type === 'pointerup' && ev.target.closest('.ed-grabber')) {
        // A tap on the grabber steps up a detent, and from large back down to the peek.
        setDetent(detent === 'peek' ? 'medium' : detent === 'medium' ? 'large' : 'peek');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  grabber.addEventListener('pointerdown', (ev) => { if (layout === 'narrow' && ev.button === 0) startPointer(ev); });

  return {
    el,
    get detent() { return detent; },
    get layout() { return layout; },
    get visible() { return layout === 'narrow' ? Math.min(visible, heights().large) : 0; },
    get depth() { return stack.length; },
    get top() { return current()?.page || null; },
    get pages() { return stack.map((e) => e.page); },
    show,
    push,
    pop,
    refresh,
    setDetent,
    heights,
    /** Container size changed or the layout switched. */
    setGeometry(next, nextLayout) {
      geo = next;
      const switched = nextLayout !== layout;
      layout = nextLayout;
      el.classList.toggle('docked', layout === 'wide');
      if (layout === 'wide') {
        el.style.transform = '';
        el.style.height = '';
        el.style.transition = '';
        el.classList.remove('scroll-locked');
        onChange?.({ visible: 0, detent, layout, animate: switched });
        return;
      }
      measurePeek();
      place(heights()[detent], false);
      el.classList.toggle('scroll-locked', detent === 'peek');
    },
    measurePeek,
    /** Slides the sheet out of view (closing) or back. */
    hide(on) { el.classList.toggle('away', on); },
  };
}

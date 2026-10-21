// Browser checks for the tiles' gestures, custom scenes and the TV's direction pad, on the
// phone layout. Runs against the panel served by Vite (no hub: the page is told it is served
// by one, and its calls are answered here, so nothing reaches a real device or plan):
//   npm --prefix web run dev          (in another terminal; or HOUSE_URL=… for another server)
//   node web/tests/tiles-scenes.mjs   (BROWSER=webkit|chromium, HOUSE_SHOTS=folder for screenshots)
// Playwright is not a dependency: npm --prefix web install --no-save --package-lock=false playwright@1.64.1
import * as pw from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.HOUSE_URL || 'http://127.0.0.1:5199';
const shots = process.env.HOUSE_SHOTS || path.join(tmpdir(), 'house-tile-checks');
await mkdir(shots, { recursive: true });
const plan = JSON.parse(await readFile(new URL('../public/plans/riley.json', import.meta.url)));
const browser = await pw[process.env.BROWSER || 'webkit'].launch();
const errors = [];

/** A page of the phone layout "served by a hub" whose calls land in `calls`. */
async function phone({ scheme = 'light', reduced = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); console.error('Browser exception:', e.stack); });
  const calls = [];
  await page.addInitScript((config) => { window.__HOUSE_BOOT__ = { hub: true, config: structuredClone(config) }; }, plan);
  await page.route('**/api/call', async (route) => {
    const body = JSON.parse(route.request().postData());
    calls.push(body);
    await route.fulfill({ json: body.type === 'savePlan' ? { ok: true, rev: calls.length } : { ok: true } });
  });
  await page.route('**/api/events', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/plan', (route) => route.fulfill({ json: calls.filter((c) => c.type === 'savePlan').at(-1)?.config || plan }));
  await page.goto(`${BASE}/?platform=ios&safeTop=59&safeBottom=34&tv=demo`);
  await page.waitForFunction(() => window.__house?.panel);
  await page.evaluate(() => { window.__house.world.setRunning(false); document.querySelector('.card').dataset.mark = 'first'; });
  return { page, calls, context };
}

/**
 * A finger on `sel`: down at (fx, fy) of its box, held `hold` ms, then along `path` ([dx, dy]
 * from there, a frame each), and up. Synthetic touch pointer events, as a phone sends them.
 */
async function finger(page, sel, { hold = 0, path = [], fx = 0.3, fy = 0.5, cancel = false, during = null } = {}) {
  return page.evaluate(async ({ sel, hold, path, fx, fy, cancel, during }) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const x0 = r.left + r.width * fx;
    const y0 = r.top + r.height * fy;
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 11, pointerType: 'touch', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
    }));
    fire('pointerdown', x0, y0);
    if (hold) await new Promise((res) => setTimeout(res, hold));
    let [x, y] = [x0, y0];
    let seen = null;
    for (const [i, [dx, dy]] of path.entries()) {
      [x, y] = [x0 + dx, y0 + dy];
      fire('pointermove', x, y);
      await frame();
      if (during && i === Math.floor(path.length / 2)) seen = { sliding: el.classList.contains('sliding'), readout: el.querySelector('.tile-readout')?.textContent, fill: el.style.getPropertyValue('--fill') };
    }
    fire(cancel ? 'pointercancel' : 'pointerup', x, y);
    await frame();
    return seen;
  }, { sel, hold, path, fx, fy, cancel, during });
}
const line = (dx, dy, n = 24) => Array.from({ length: n }, (_, i) => [(dx * (i + 1)) / n, (dy * (i + 1)) / n]);
const tile = (key) => `.tile[data-key="${key}"]`;
const light = (page, id) => page.evaluate((id) => ({ ...window.__house.store.state.lights[id] }), id);
const ac = (page, id) => page.evaluate((id) => ({ ...window.__house.store.state.acs[id] }), id);
const sheet = (page) => page.evaluate(() => window.__house.panel.sheetTarget);
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
// A tile mid-slide, for a picture: the card pulled up and the tile in view.
async function slidingShot(page, sel, fill, text, name) {
  await page.evaluate(() => window.__house.panel.deck.set('expanded', { animate: false }));
  await page.locator(sel).scrollIntoViewIfNeeded();
  await page.evaluate(({ sel, fill, text }) => {
    const el = document.querySelector(sel);
    el.classList.add('sliding');
    el.style.setProperty('--fill', fill);
    el.querySelector('.tile-readout').textContent = text;
  }, { sel, fill, text });
  await wait(300);
  await shot(page, name);
  await page.evaluate((sel) => document.querySelector(sel).classList.remove('sliding'), sel);
  await page.evaluate(() => window.__house.panel.deck.set('rest', { animate: false }));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { page, calls } = await phone();
  const commands = () => calls.filter((c) => c.type === 'command');
  await shot(page, '01-home');

  /* ---------- a lamp: slide, tap, hold ---------- */
  const lamp = 'studio.window';
  await page.locator(tile(lamp)).scrollIntoViewIfNeeded();
  assert.equal((await light(page, lamp)).on, false);
  const width = await page.locator(tile(lamp)).evaluate((el) => el.clientWidth);
  const before = commands().length;
  const seen = await finger(page, tile(lamp), { path: [[4, 0], [9, 1], ...line(width * 0.6 + 9, 2, 40)], during: true });
  assert.ok(seen.sliding && /%$/.test(seen.readout), `shows the level while sliding: ${JSON.stringify(seen)}`);
  await wait(50);
  let s = await light(page, lamp);
  assert.ok(s.on && Math.abs(s.brightness - 0.6) < 0.06, `slid from off to about 60 %: ${JSON.stringify(s)}`);
  await wait(400);
  const sent = commands().slice(before).filter((c) => c.id === lamp);
  assert.ok(sent.length >= 1 && sent.length <= 3, `the slide's 42 moves cost ${sent.length} commands`);
  assert.equal(sent.at(-1).state.brightness, s.brightness);
  assert.equal(await sheet(page), null, 'a slide opens nothing');
  // Mid-slide picture.
  await slidingShot(page, tile(lamp), '0.6', '60%', '02-lamp-sliding');

  await finger(page, tile(lamp));
  assert.equal((await light(page, lamp)).on, false, 'a tap switches it off');
  await finger(page, tile(lamp));
  assert.equal((await light(page, lamp)).on, true, 'and on again');

  // Up or down is the card's or the list's: neither a tap nor a slide.
  await finger(page, tile(lamp), { path: line(3, 60, 10) });
  s = await light(page, lamp);
  assert.equal(s.on, true, 'a vertical drag does not toggle');
  await page.evaluate(() => window.__house.panel.deck.set('rest', { animate: false }));
  // A sideways slide the browser takes over (pointercancel) keeps the level it reached.
  await finger(page, tile(lamp), { path: line(-width * 0.3, 0, 12), cancel: true });
  assert.equal((await light(page, lamp)).on, true, 'a cancelled slide does not toggle');

  await page.locator(tile(lamp)).scrollIntoViewIfNeeded();
  await finger(page, tile(lamp), { hold: 650 });
  await wait(100);
  assert.deepEqual(await sheet(page), { kind: 'light', id: lamp }, 'held and let go: its page');
  assert.equal((await light(page, lamp)).on, true, 'and not toggled');
  await page.evaluate(() => window.__house.panel.closeSheet());
  await wait(350);

  /* ---------- the AC ---------- */
  const acId = 'studio.ac';
  await page.locator(tile(acId)).scrollIntoViewIfNeeded();
  const a0 = await ac(page, acId);
  const acSeen = await finger(page, tile(acId), { fx: 0.4, path: [[5, 0], [9, 0], ...line(9 + 24 * 3 + 6, 0, 30)], during: true });
  assert.match(acSeen.readout, /^\d+°$/, 'the temperature in big type while sliding');
  await wait(50);
  let a1 = await ac(page, acId);
  assert.equal(a1.target, a0.target + 3, `three degrees warmer: ${a0.target} → ${a1.target}`);
  assert.equal(a1.on, true);
  await slidingShot(page, tile(acId), '0.55', '77°', '03-ac-sliding');
  await finger(page, tile(acId), { fx: 0.3 });
  assert.equal((await ac(page, acId)).on, false, 'a tap switches the AC off');
  await finger(page, tile(acId), { fx: 0.3 });
  assert.equal((await ac(page, acId)).on, true, 'and on');
  await finger(page, tile(acId), { fx: 0.3, hold: 650 });
  await wait(100);
  assert.deepEqual(await sheet(page), { kind: 'ac', id: acId }, 'held: the AC page');
  assert.equal((await ac(page, acId)).on, true);
  await page.evaluate(() => window.__house.panel.closeSheet());
  await wait(350);

  /* ---------- hold and drag: the order ---------- */
  await page.locator(tile('kitchen.edison')).scrollIntoViewIfNeeded();
  const kitchen0 = await light(page, 'kitchen.edison');
  const gap = await page.evaluate(() => {
    const [a, b] = ['kitchen.edison', 'kitchen.counter'].map((k) => document.querySelector(`.tile[data-key="${k}"]`).getBoundingClientRect());
    return b.left - a.left;
  });
  await finger(page, tile('kitchen.edison'), { hold: 650, path: line(gap + 40, 0, 16) });
  await wait(900);
  const order = await page.evaluate(() => window.__house.panel.order);
  assert.ok(order.indexOf('kitchen.counter') < order.indexOf('kitchen.edison'), `moved: ${order}`);
  assert.equal(await sheet(page), null, 'a drop opens nothing');
  assert.deepEqual(await light(page, 'kitchen.edison'), kitchen0, 'and toggles nothing');
  const savedOrder = calls.filter((c) => c.type === 'savePlan').at(-1);
  assert.ok(savedOrder?.config.tileOrder.indexOf('kitchen.counter') < savedOrder.config.tileOrder.indexOf('kitchen.edison'), 'the order is saved');

  /* ---------- the mouse ---------- */
  await page.evaluate(() => window.__house.panel.deck.set('expanded', { animate: false }));
  await page.locator(tile('studio.door')).scrollIntoViewIfNeeded();
  await wait(100);
  const box = await page.locator(tile('studio.door')).boundingBox();
  await page.mouse.click(box.x + 30, box.y + box.height / 2);
  assert.equal((await light(page, 'studio.door')).on, true, 'a click switches a lamp');
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 20 + (box.width * 0.5 * i) / 20 + 9, box.y + box.height / 2);
  await page.mouse.up();
  await wait(50);
  s = await light(page, 'studio.door');
  assert.ok(s.on && s.brightness > 0.95, `a mouse slide brightens it: ${s.brightness}`);
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await wait(650);
  await page.mouse.up();
  await wait(100);
  assert.deepEqual(await sheet(page), { kind: 'light', id: 'studio.door' }, 'a held click opens the page');
  await page.evaluate(() => window.__house.panel.closeSheet());
  await wait(350);

  /* ---------- scenes ---------- */
  await page.evaluate(() => { window.__house.panel.deck.set('rest', { animate: false }); document.querySelector('.devices').scrollTop = 0; });
  await page.getByRole('button', { name: 'New scene' }).click();
  await wait(450);
  assert.deepEqual(await sheet(page), { kind: 'scene', id: null });
  await page.getByLabel('Scene name').fill('Movie night');
  await page.getByRole('button', { name: 'Film', exact: true }).click();
  await page.getByRole('button', { name: 'Include AC' }).click();
  await shot(page, '04-new-scene');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await wait(400);
  const made = await page.evaluate(() => window.__house.config.scenes.at(-1));
  assert.match(made.id, /^custom-movie-night-[0-9a-f]{4}$/);
  assert.equal(made.icon, 'film');
  assert.deepEqual(Object.keys(made.lights).sort(), plan.lights.map((l) => l.id).sort(), 'every lamp');
  const now = await page.evaluate(() => window.__house.store.state);
  for (const [id, l] of Object.entries(made.lights)) {
    assert.equal(l.on, now.lights[id].on, id);
    if (l.on) assert.equal(l.brightness, Math.round(now.lights[id].brightness * 100) / 100, id);
  }
  assert.deepEqual(made.acs[acId], { on: now.acs[acId].on, mode: now.acs[acId].mode, target: now.acs[acId].target, fan: now.acs[acId].fan });
  assert.equal(now.scene, made.id, 'made from the lights as they are: the scene they are in');
  await page.waitForFunction(() => document.querySelector('.scene.active'));
  await wait(800);
  let saved = calls.filter((c) => c.type === 'savePlan').at(-1).config;
  assert.deepEqual(saved.scenes.at(-1), { id: made.id, name: 'Movie night', icon: 'film', lights: made.lights, acs: made.acs }, 'saved in the plan, in the agreed shape');
  assert.deepEqual(saved.scenes.slice(0, -1), plan.scenes, 'the built-in scenes as they were');
  assert.equal(await page.evaluate(() => document.querySelector('.card').dataset.mark), 'first', 'kept in place: no new card');
  await shot(page, '05-scene-made');

  // Held: Edit or Delete.
  await page.evaluate(() => { document.querySelector('.scenes').scrollLeft = 1e4; });
  const chip = `.scene[title="Movie night"]`;
  await finger(page, chip, { hold: 600, fx: 0.5 });
  await page.waitForSelector('.menu');
  await shot(page, '06-scene-menu');
  await page.locator('.menu button', { hasText: 'Edit' }).click();
  await wait(450);
  assert.deepEqual(await sheet(page), { kind: 'scene', id: made.id });
  await page.evaluate(() => window.__house.store.setLight('kitchen.edison', { on: true, brightness: 0.3, temp: 2400 }));
  await page.getByLabel('Scene name').fill('Movie');
  await page.getByRole('button', { name: 'Update to current lights' }).click();
  await page.getByRole('button', { name: 'Include AC' }).click(); // off: the scene leaves the AC alone
  await shot(page, '07-edit-scene');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await wait(900);
  saved = calls.filter((c) => c.type === 'savePlan').at(-1).config;
  const edited = saved.scenes.find((x) => x.id === made.id);
  assert.equal(edited.name, 'Movie');
  assert.deepEqual(edited.lights['kitchen.edison'], { on: true, brightness: 0.3, temp: 2400 });
  assert.ok(!('acs' in edited), 'no AC: no "acs"');

  // A tap sets it; then delete it, and a built-in one.
  await page.evaluate(() => window.__house.store.setAllLights(false));
  await page.locator('.scene[title="Movie"]').click();
  assert.equal((await light(page, 'kitchen.edison')).brightness, 0.3, 'a tap on the chip applies it');
  await finger(page, '.scene[title="Movie"]', { hold: 600, fx: 0.5 });
  await page.locator('.menu button', { hasText: 'Delete' }).click();
  await finger(page, '.scene[title="Night"]', { hold: 600, fx: 0.5 });
  await page.locator('.menu button', { hasText: 'Delete' }).click();
  await wait(900);
  saved = calls.filter((c) => c.type === 'savePlan').at(-1).config;
  assert.deepEqual(saved.scenes.map((x) => x.id), plan.scenes.map((x) => x.id).filter((id) => id !== 'night'));
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.scene')].map((b) => b.textContent)), ['Bright', 'Cozy', 'All off', 'New']);

  // Another screen saved scenes: taken in place.
  await page.evaluate((scenes) => window.__house.panel.setScenes(scenes), [...plan.scenes, { id: 'custom-reading-0a1b', name: 'Reading', icon: 'office', lights: { '*': { on: true, brightness: 0.9, temp: 4000 } } }]);
  assert.ok(await page.locator('.scene[title="Reading"]').isVisible());

  /* ---------- the TV ---------- */
  const tvKey = await page.evaluate(() => document.querySelector('.tile.tv')?.dataset.key);
  assert.ok(tvKey, 'the demo TV has a tile');
  const tvId = tvKey.slice(3);
  await page.evaluate(() => {
    const { tv } = window.__house;
    const act = tv.act.bind(tv);
    window.__acts = [];
    tv.act = (id, body) => { window.__acts.push(body.action); return act(id, body); };
  });
  await page.locator(tile(tvKey)).scrollIntoViewIfNeeded();
  const wasOn = await page.evaluate((id) => Boolean(window.__house.tv.device(id)?.on), tvId);
  await finger(page, tile(tvKey), { fx: 0.3 });
  assert.deepEqual(await page.evaluate(() => window.__acts), [wasOn ? 'sleep' : 'wake'], 'a tap is the TV\'s power');
  await finger(page, tile(tvKey), { fx: 0.3, hold: 650 });
  await wait(1000);
  assert.deepEqual(await sheet(page), { kind: 'tv', id: tvId }, 'held: the remote');
  const disc = await page.locator('.tv-dpad-disc').boundingBox();
  assert.ok(disc.width >= 230 && disc.width <= 262, `the pad is ${disc.width} px across`);
  await page.locator('.tv-dpad-disc').scrollIntoViewIfNeeded();
  await page.evaluate(() => { window.__acts.length = 0; });
  await finger(page, '.tv-dpad-disc', { fx: 0.92, fy: 0.5 });
  await finger(page, '.tv-dpad-disc', { fx: 0.5, fy: 0.5 });
  await finger(page, '.tv-dpad-disc', { fx: 0.5, fy: 0.27 }); // between OK and the rim: nothing
  await finger(page, '.tv-dpad-disc', { fx: 0.97, fy: 0.03 }); // the corner, outside the disc: nothing
  assert.deepEqual(await page.evaluate(() => window.__acts), ['right', 'ok']);
  await page.evaluate(() => { window.__acts.length = 0; });
  await finger(page, '.tv-dpad-disc', { fx: 0.5, fy: 0.08, hold: 680, path: line(60, 40, 6) }); // held, and the finger wanders: still up
  const held = await page.evaluate(() => window.__acts);
  assert.ok(held.length >= 4 && held.every((a) => a === 'up'), `held up repeats: ${held}`);
  await page.evaluate(() => {
    const d = document.querySelector('.tv-dpad-disc');
    d.dataset.pressed = 'right';
    d.querySelector('.tv-dpad-zone.right').classList.add('pressed');
  });
  await shot(page, '08-tv-dpad');
  await page.locator('.tv-dpad').focus();
  await page.evaluate(() => { window.__acts.length = 0; });
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  assert.deepEqual(await page.evaluate(() => window.__acts), ['left', 'ok', 'back'], 'the keyboard still drives it');

  /* ---------- the dark look, reduced motion ---------- */
  const dark = await phone({ scheme: 'dark', reduced: true });
  await dark.page.evaluate((id) => window.__house.panel.openSheet({ kind: 'tv', id }), tvId);
  await wait(900);
  await dark.page.locator('.tv-dpad-disc').scrollIntoViewIfNeeded();
  await dark.page.evaluate(() => { const d = document.querySelector('.tv-dpad-disc'); d.dataset.pressed = 'up'; d.querySelector('.tv-dpad-zone.up').classList.add('pressed'); });
  await shot(dark.page, '09-tv-dpad-dark');
  await dark.page.evaluate(() => window.__house.panel.closeSheet());
  await wait(300);
  await finger(dark.page, tile('studio.window'), { path: [[9, 0], ...line(120, 0, 12)] });
  assert.equal((await light(dark.page, 'studio.window')).on, true, 'reduced motion: still slides');
  await dark.page.getByRole('button', { name: 'New scene' }).click();
  await wait(300);
  await shot(dark.page, '10-new-scene-dark');

  assert.deepEqual(errors, [], 'no exceptions in the page');
  console.log(`All tile, scene and pad checks passed. Screenshots in ${shots}`);
} finally {
  await browser.close();
}

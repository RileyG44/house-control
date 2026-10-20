// Browser acceptance checks. No production dependencies are added:
// npm --prefix web install --no-save --package-lock=false playwright@1.64.1
// npx --prefix web playwright install chromium
// python web/tests/editor-hub.py   (in another terminal, after building web)
// node web/tests/editor.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.js';

const HUB = 'http://127.0.0.1:8777';
const PREVIEW = 'http://127.0.0.1:8778';
const shots = process.env.HOUSE_EDITOR_SHOTS || path.join(tmpdir(), 'house-editor-checks');
await mkdir(shots, { recursive: true });
const raw = JSON.parse(await readFile(new URL('../public/plans/home.json', import.meta.url)));
const windowsSource = await readFile(new URL('../../windows/src/main.js', import.meta.url), 'utf8');
const tileCSS = windowsSource.match(/const TILE_CSS = `([\s\S]*?)`;/)[1].replaceAll('${PAD}', '14');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const contexts = [];
async function context(opts = {}) {
  const c = await browser.newContext(opts);
  c.setDefaultTimeout(30000);
  contexts.push(c);
  c.on('page', p => p.on('pageerror', e => { errors.push(e.message); console.error('Browser exception:', e.stack); }));
  return c;
}
async function until(page, predicate, arg) { await page.waitForFunction(predicate, arg, { timeout: 30000 }); }
async function shot(page, name) { await page.waitForTimeout(650); await page.screenshot({ path: path.join(shots, `${name}.png`) }); }
async function ready(page, url) {
  await page.goto(url);
  await until(page, () => Boolean(window.__house || window.__editor));
  // Software WebGL on CI needs only a still panel here. Opening the editor starts
  // its camera again; keeping unrelated panels animating starves pointer checks.
  await page.evaluate(() => window.__house?.world.setRunning(false));
}
async function open(page) {
  await page.getByRole('button', { name: 'Edit home', exact: true }).click();
  await until(page, () => Boolean(window.__editor) && !document.querySelector('.ed.entering'));
}
async function saved(page) {
  assert.equal(await page.evaluate(() => window.__editor.flush()), true);
  await until(page, () => window.__editor.status === 'saved');
}
async function rename(page, name) {
  await page.evaluate(() => window.__editor.select({ kind: 'room', id: window.__editor.doc.rooms[0].id }));
  await page.getByPlaceholder('Room name', { exact: true }).fill(name);
}
async function saveRemote(page, config) {
  const result = await page.request.post(`${HUB}/api/call`, { data: { type: 'savePlan', config, client: 'external-test' } });
  assert.equal((await result.json()).ok, true);
}
async function check(label, fn) {
  if (process.env.HOUSE_EDITOR_CHECK && !new RegExp(process.env.HOUSE_EDITOR_CHECK).test(label)) return;
  console.log(`CHECK ${label}`);
  try { await fn(); console.log(`PASS ${label}`); }
  catch (error) {
    for (const c of contexts) for (const p of c.pages()) {
      console.error('Failed page:', p.url(), await p.locator('body').innerText().catch(() => 'unavailable'));
      await p.screenshot({ path: path.join(shots, 'failure.png'), timeout: 5000 }).catch(() => {});
    }
    throw error;
  }
}

try {
  await fetch(`${HUB}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'savePlan', config: raw }) });
  await check('widget: catalog, room movement/resizing, lamp deletion/undo, device picker, Done', async () => {
    const c = await context({ viewport: { width: 468, height: 828 }, userAgent: 'House Control Electron/44.7.2' });
    const p = await c.newPage();
    await ready(p, `${HUB}/?platform=web&mode=panel`);
    await p.addStyleTag({ content: tileCSS });
    await open(p);
    assert.equal(await p.evaluate(() => window.__editor.layout), 'narrow');
    await shot(p, 'widget-home-peek');
    await p.evaluate(() => window.__editor.sheet.setDetent('medium', false));
    await shot(p, 'widget-home-medium');
    await p.getByRole('button', { name: 'Add to the home', exact: true }).click();
    await shot(p, 'widget-add');
    await p.getByRole('button', { name: 'Bedroom', exact: true }).click();
    await until(p, () => window.__editor.sel?.kind === 'room');
    await p.waitForTimeout(650);
    const id = await p.evaluate(() => window.__editor.sel.id);
    const before = await p.evaluate(id => window.__editor.doc.rooms.find(r => r.id === id).rect.slice(), id);
    const point = await p.evaluate(id => {
      const e = window.__editor, r = e.doc.rooms.find(r => r.id === id).rect;
      const [x, y] = e.plan.toScreen([r[0] + .3, r[1] + .3]);
      const b = e.plan.svg.getBoundingClientRect(); return { x: x + b.x, y: y + b.y };
    }, id);
    await p.mouse.move(point.x, point.y); await p.mouse.down();
    await p.mouse.move(point.x + 22, point.y + 12, { steps: 7 }); await p.mouse.up();
    assert.notDeepEqual(await p.evaluate(id => window.__editor.doc.rooms.find(r => r.id === id).rect, id), before);
    // A real edge handle changes geometry, not just the property's form.
    const handle = p.locator('.ed-handles .ed-knob.edge').first();
    const box = await handle.boundingBox();
    assert.ok(box, 'room edge handle is visible');
    const sizeBefore = await p.evaluate(id => window.__editor.doc.rooms.find(r => r.id === id).rect.slice(2), id);
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 18, { steps: 6 }); await p.mouse.up();
    assert.notDeepEqual(await p.evaluate(id => window.__editor.doc.rooms.find(r => r.id === id).rect.slice(2), id), sizeBefore);
    await shot(p, 'widget-room-handles');
    await p.getByRole('button', { name: 'Add light', exact: true }).click();
    await p.getByRole('button', { name: 'Table lamp', exact: true }).click();
    await until(p, () => window.__editor.sel?.kind === 'light');
    await p.waitForTimeout(650); // the sheet settles on the new lamp's page before it is opened up
    await p.evaluate(() => window.__editor.sheet.setDetent('large', false));
    await shot(p, 'widget-light');
    const lamp = await p.evaluate(() => window.__editor.sel.id);
    await p.getByRole('button', { name: /Real device/ }).click();
    await p.getByRole('button', { name: /Test network lamp/ }).click();
    await saved(p);
    assert.equal(await p.evaluate(id => window.__editor.doc.lights.find(l => l.id === id).link.id, lamp), 'test-bulb');
    await p.getByRole('button', { name: /Real device/ }).click();
    await shot(p, 'widget-device-picker');
    await p.keyboard.press('Escape');
    await p.getByRole('button', { name: 'Delete', exact: true }).click();
    assert.equal(await p.evaluate(id => window.__editor.doc.lights.some(l => l.id === id), lamp), false);
    await p.getByRole('button', { name: 'Undo', exact: true }).first().click();
    assert.equal(await p.evaluate(id => window.__editor.doc.lights.some(l => l.id === id), lamp), true);
    await p.evaluate(() => { window.__editor.select(null); window.__editor.sheet.setDetent('large', false); });
    await p.getByRole('button', { name: 'Add to the home', exact: true }).click();
    await p.getByRole('button', { name: 'Sofa', exact: true }).scrollIntoViewIfNeeded();
    await shot(p, 'widget-furniture-catalog');
    await p.getByRole('button', { name: 'Sofa', exact: true }).click();
    await saved(p);
    await p.getByRole('button', { name: 'Done', exact: true }).click();
    await until(p, () => !window.__editor && window.__house.config.lights.some(l => l.link?.id === 'test-bulb'));
    await p.waitForTimeout(1200);
    await p.evaluate(() => window.__house.world.settle());
    await shot(p, 'widget-done');
    await c.close();
  });

  await check('desktop and two-screen sync: hot swap, own echo, remote adoption, conflicts, reconnect', async () => {
    const ca = await context({ viewport: { width: 1440, height: 900 } });
    const cb = await context({ viewport: { width: 1440, height: 900 } });
    const a = await ca.newPage(), b = await cb.newPage();
    await ready(a, HUB); await ready(b, HUB);
    await b.evaluate(() => { window.marker = 'survived'; });
    await open(a);
    assert.equal(await a.evaluate(() => window.__editor.layout), 'wide');
    await a.evaluate(() => { window.ownEditor = window.__editor; });
    await rename(a, 'Synced room'); await saved(a);
    await until(b, () => window.__house.config.rooms[0].name === 'Synced room');
    assert.equal(await b.evaluate(() => window.marker), 'survived');
    assert.equal(await a.evaluate(() => window.ownEditor === window.__editor), true);
    console.log('  hot swap and own echo passed');
    await open(b);
    await rename(a, 'Remote adopted'); await saved(a);
    await until(b, () => window.__editor.doc.rooms[0].name === 'Remote adopted');
    // Keep an unsaved edit when an external plan arrives, then persist ours.
    await rename(b, 'My pending edit');
    await b.evaluate(() => {
      const remote = structuredClone(window.__editor.doc);
      remote.rooms[0].name = 'Other writer'; window.__editor.adoptRemote(remote);
    });
    assert.equal(await b.evaluate(() => window.__editor.doc.rooms[0].name), 'My pending edit');
    await saved(b);
    await until(a, () => window.__editor.doc.rooms[0].name === 'My pending edit');
    console.log('  editor adoption and pending-edit conflict passed');
    // A lost connection misses all save events; reconnect must fetch the latest plan.
    await cb.setOffline(true);
    await rename(a, 'Changed while offline'); await saved(a);
    await cb.setOffline(false);
    await until(b, () => window.__editor.doc.rooms[0].name === 'Changed while offline');
    console.log('  reconnect passed');
    const hub = await (await a.request.get(`${HUB}/api/plan`)).json();
    const panel = await (await a.request.get(`${PREVIEW}/__test/panel`)).json();
    assert.deepEqual(panel, hub);
    normalize(structuredClone(hub));
    assert.ok(!await a.locator('.ed-toast').innerText().then(t => /\bnull\b/.test(t)));
    await shot(a, 'desktop-wide');
    await a.getByRole('radio', { name: '3D', exact: true }).click();
    await a.waitForTimeout(500); await shot(a, 'desktop-3d');
    await a.getByRole('radio', { name: '2D', exact: true }).click();
    const furniture = await a.evaluate(() => {
      const e=window.__editor, index=e.doc.furniture.findIndex(f=>f.type==='sofa');
      e.select({kind:'furniture',index}); e.plan.svg.focus();
      return {index,count:e.doc.furniture.length,rot:e.doc.furniture[index].rot||0};
    });
    await a.keyboard.press('r');
    assert.notEqual(await a.evaluate(i=>window.__editor.doc.furniture[i].rot,furniture.index),furniture.rot);
    await a.keyboard.press('Control+d');
    assert.equal(await a.evaluate(()=>window.__editor.doc.furniture.length),furniture.count+1);
    await a.keyboard.press('Control+z');
    assert.equal(await a.evaluate(()=>window.__editor.doc.furniture.length),furniture.count);
    await a.getByRole('button', { name: 'Done', exact: true }).click();
    await until(a, () => !window.__editor);
    await until(a, () => document.querySelector('.card').getBoundingClientRect().width < 500);
    await ca.close(); await cb.close();
  });

  await check('phone: safe areas, touch hold/drag, pinch, deferred remote update, sheet detents', async () => {
    const c = await context({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await c.newPage();
    await ready(p, `${HUB}/?platform=ios&safeTop=47&safeBottom=34`);
    await open(p);
    await shot(p, 'phone-home');
    const session = await c.newCDPSession(p);
    const touch = (type, points) => session.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x,y,id]) => ({ x,y,id })) });
    const scale = await p.evaluate(() => window.__editor.view().s);
    await touch('touchStart', [[140,230,1],[240,230,2]]);
    await touch('touchMove', [[110,230,1],[270,230,2]]);
    const remote = await p.evaluate(() => { const d=structuredClone(window.__editor.doc); d.name='During pinch'; return d; });
    await saveRemote(p, remote);
    await p.waitForTimeout(120);
    assert.notEqual(await p.evaluate(() => window.__editor.doc.name), 'During pinch');
    await touch('touchEnd', []);
    await until(p, () => window.__editor.doc.name === 'During pinch');
    assert.ok(await p.evaluate(s => window.__editor.view().s > s, scale));
    await p.locator('.ed-grabber').tap();
    await until(p,()=>window.__editor.sheet.detent==='medium');
    await shot(p, 'phone-medium');
    await p.getByRole('button', { name: 'Add to the home', exact: true }).click();
    const toastFits = await p.evaluate(() => {
      const toast=document.querySelector('.ed-toast.show');
      return !toast || toast.getBoundingClientRect().top >= document.querySelector('.ed-bar').getBoundingClientRect().bottom;
    });
    assert.ok(toastFits, 'notifications stay below the phone status/header area');
    await shot(p, 'phone-add');
    await p.getByRole('button', { name: 'Bedroom', exact: true }).click();
    await p.waitForTimeout(650);
    const point = await p.evaluate(() => {
      const e=window.__editor, r=e.doc.rooms.find(r=>r.id===e.sel.id).rect;
      const [x,y]=e.plan.toScreen([r[0]+.4,r[1]+.4]); const b=e.plan.svg.getBoundingClientRect();
      return { x:x+b.x,y:y+b.y,id:e.sel.id,rect:r.slice() };
    });
    await p.evaluate(()=>window.__editor.select(null));
    await touch('touchStart', [[point.x,point.y,1]]);
    await p.waitForTimeout(350);
    await touch('touchMove', [[point.x+24,point.y+12,1]]); await touch('touchEnd', []);
    assert.notDeepEqual(await p.evaluate(id=>window.__editor.doc.rooms.find(r=>r.id===id).rect, point.id), point.rect);
    await saved(p);
    await shot(p, 'phone-room');
    await c.close();
  });

  await check('standalone hub: desktop and phone Done return to panel', async () => {
    for (const [platform,width,height] of [['web',1240,800],['ios',390,844]]) {
      const c=await context({ viewport:{width,height} }); const p=await c.newPage();
      await ready(p, `${HUB}/?mode=editor&platform=${platform}`);
      assert.equal(await p.evaluate(()=>window.__editor.layout), platform==='web'?'wide':'narrow');
      await shot(p, `standalone-${platform}`);
      await p.getByRole('button',{name:'Done',exact:true}).click();
      await until(p,()=>Boolean(window.__house) && !window.__editor);
      await c.close();
    }
  });

  await check('plain preview: overlay and standalone Done preserve edits without saving', async () => {
    for (const standalone of [false,true]) {
      const c=await context({viewport:{width:1240,height:800}}); const p=await c.newPage();
      await ready(p, `${PREVIEW}/?platform=web${standalone?'&mode=editor':''}`);
      if (!standalone) await open(p);
      assert.equal(await p.evaluate(()=>window.__editor.status),'preview');
      await rename(p, 'Preview changed');
      await shot(p, `preview-${standalone?'standalone':'overlay'}`);
      await p.getByRole('button',{name:'Done',exact:true}).click();
      await until(p,()=>!window.__editor && window.__house?.config.rooms[0].name==='Preview changed');
      await c.close();
    }
  });

  await check('native shell contract: Mac Done capability, iPhone close, saves and planArrived', async () => {
    for (const [platform,canClose] of [['macos',true],['macos',false],['ios',false]]) {
      const c=await context({viewport:{width:platform==='ios'?390:1240,height:800}});
      await c.addInitScript(({raw,platform,canClose})=>{
        window.__HOUSE_BOOT__={config:raw,platform,mode:'editor',canClose,services:{}};
        window.nativeMessages=[];
        window.webkit={messageHandlers:{house:{postMessage(msg){
          window.nativeMessages.push(msg);
          if(msg.callId) queueMicrotask(()=>window.house.reply(msg.callId,msg.type==='devices.all'?{devices:[]}:{ok:true}));
        }}}};
      }, {raw,platform,canClose});
      const p=await c.newPage(); await ready(p,PREVIEW);
      const hasDone=platform==='ios'||canClose;
      assert.equal(await p.getByRole('button',{name:'Done',exact:true}).count(),hasDone?1:0);
      await rename(p,'Native changed'); await saved(p);
      assert.ok(await p.evaluate(()=>window.nativeMessages.some(m=>m.type==='savePlan'&&m.config.rooms[0].name==='Native changed')));
      await p.evaluate(()=>{ const d=structuredClone(window.__editor.doc);d.name='Paired update';window.house.planArrived(d,'paired phone'); });
      assert.equal(await p.evaluate(()=>window.__editor.doc.name),'Paired update');
      await shot(p,`native-${platform}-${canClose}`);
      if(hasDone){ await p.getByRole('button',{name:'Done',exact:true}).click(); await until(p,()=>window.nativeMessages.some(m=>m.type==='close')); }
      await c.close();
    }
  });

  await check('native save ordering: remote change during a save is overwritten by the pending local edit', async () => {
    const c=await context({viewport:{width:1240,height:800}});
    await c.addInitScript(raw=>{
      window.__HOUSE_BOOT__={config:raw,platform:'macos',mode:'editor',canClose:true,services:{}};
      window.saves=[];
      window.webkit={messageHandlers:{house:{postMessage(msg){
        if(msg.type==='savePlan') window.saves.push(msg);
        else if(msg.callId) queueMicrotask(()=>window.house.reply(msg.callId,{}));
      }}}};
    },raw);
    const p=await c.newPage(); await ready(p,PREVIEW);
    await rename(p,'Pending local change');
    await p.evaluate(()=>{ void window.__editor.flush(); });
    await until(p,()=>window.saves.length===1);
    await p.evaluate(()=>{
      const remote=structuredClone(window.__editor.doc); remote.rooms[0].name='Other screen';
      window.house.planArrived(remote,'other screen');
      window.house.reply(window.saves[0].callId,{ok:true});
    });
    await until(p,()=>window.saves.length===2);
    assert.equal(await p.evaluate(()=>window.saves[1].config.rooms[0].name),'Pending local change');
    await p.evaluate(()=>window.house.reply(window.saves[1].callId,{ok:true}));
    await until(p,()=>window.__editor.status==='saved');
    await c.close();
  });

  assert.deepEqual(errors, [], 'no browser exceptions');
  console.log(`Screenshots: ${shots}`);
} finally {
  await browser.close();
}

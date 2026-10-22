import { test, expect } from '@playwright/test';

const data = (request) => request.get('/test/state').then((r) => r.json());
test.beforeEach(async ({ page, request }) => {
  page.houseErrors = [];
  page.on('pageerror', (e) => page.houseErrors.push(e.message));
  await request.post('/test/reset');
  await page.goto('/');
  await expect(page.locator('.tile.tv')).toBeVisible();
  await page.getByRole('button', { name: 'Show more controls', exact: true }).click();
  await expect(page.locator('.deck')).toHaveClass(/open/);
});
test.afterEach(async ({ page }) => expect(page.houseErrors).toEqual([]));

test('AC and TV taps open controls; a TV swipe sends volume without power', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.tile.ac .tile-name').click();
  await expect(page.locator('.sheet-name')).toContainText('AC');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.tile.tv .tile-name').click();
  await expect(page.locator('.sheet-name')).toContainText('Studio TV');
  await page.locator('.sheet-head').getByRole('button', { name: 'Back', exact: true }).click();
  const box = await page.locator('.tile.tv').boundingBox();
  await page.mouse.move(box.x + 70, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 70, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await data(request)).sent.filter((s) => s.route === 'tv' && s.action === 'volume').length).toBeGreaterThan(0);
  const sent = (await data(request)).sent;
  expect(sent.some((s) => ['sleep', 'wake', 'power'].includes(s.action) || s.patch?.on === false)).toBe(false);
  expect(errors).toEqual([]);
});

test('presets drag into order and remain deleted after reload, including the last one', async ({ page, request }) => {
  const first = page.locator('.scene[data-key="bright"]');
  const last = page.locator('.scene[data-key="night"]');
  const from = await first.boundingBox(), to = await last.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.move(to.x + to.width / 2 + 10, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await data(request)).plan.scenes.map((s) => s.id)).toEqual(['movie', 'night', 'bright']);
  await page.reload();
  await expect(page.locator('.scene[data-key]').first()).toHaveAttribute('data-key', 'movie');
  for (const id of ['bright', 'movie', 'night']) {
    const chip = page.locator(`.scene[data-key="${id}"]`);
    await chip.click({ button: 'right' });
    await page.getByRole('button', { name: /^Delete “/ }).click();
    await expect(chip).toHaveCount(0);
  }
  await expect.poll(async () => (await data(request)).plan.scenes).toEqual([]);
  await page.reload();
  await expect(page.locator('.scene[data-key]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New scene', exact: true })).toBeVisible();
});

test('a held finger reorders a preset without scrolling or applying it', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, 'Phone touch behavior');
  const from = await page.locator('.scene[data-key="bright"]').boundingBox();
  const to = await page.locator('.scene[data-key="night"]').boundingBox();
  const session = await page.context().newCDPSession(page);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2 + 10, y: to.y + to.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  await page.waitForTimeout(500);
  for (let i = 1; i <= 12; i++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * i / 12, y: start.y }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await data(request)).plan.scenes.map((s) => s.id)).toEqual(['movie', 'night', 'bright']);
  expect((await data(request)).sent.some((s) => s.type === 'command' || s.route === 'tv')).toBe(false);
});

test('a preset keeps its TV app while editing and launches it with light and AC changes', async ({ page, request }) => {
  await page.locator('.scene[data-key="movie"]').click({ button: 'right' });
  await page.getByText('Edit', { exact: true }).click();
  const app = page.getByLabel('Studio TV app', { exact: true });
  await expect(app).toHaveValue('netflix');
  await app.selectOption('hulu');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await data(request)).plan.scenes.find((s) => s.id === 'movie')?.tvs?.['test-tv']?.app).toBe('hulu');
  await page.locator('.scene[data-key="movie"]').click();
  await expect.poll(async () => (await data(request)).sent.some((s) => s.route === 'tv' && s.action === 'open' && s.app === 'hulu')).toBe(true);
  const sent = (await data(request)).sent;
  expect(sent.some((s) => s.kind === 'light' && s.patch?.brightness === 0.2)).toBe(true);
  expect(sent.some((s) => s.kind === 'ac' && s.patch?.target === 72)).toBe(true);
  await page.reload();
  await page.locator('.scene[data-key="movie"]').click({ button: 'right' });
  await page.getByText('Edit', { exact: true }).click();
  await expect(page.getByLabel('Studio TV app', { exact: true })).toHaveValue('hulu');
});

test('speaker opens Spotify, controls playback and chooses an actual output', async ({ page, request }) => {
  await page.locator('.tile.speaker').click();
  await expect(page.locator('.sheet-name')).toHaveText('Spotify');
  await expect(page.locator('.spotify-title')).toHaveText('A quiet evening');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByLabel('Spotify output', { exact: true }).selectOption('mac');
  await expect.poll(async () => (await data(request)).sent.some((s) => s.route === 'spotify' && s.action === 'transfer' && s.device === 'mac')).toBe(true);
  await page.getByRole('button', { name: 'Next track', exact: true }).click();
  await expect.poll(async () => (await data(request)).sent.some((s) => s.route === 'spotify' && s.action === 'next')).toBe(true);
  await page.getByLabel('Spotify output', { exact: true }).selectOption('echo');
  await page.getByRole('button', { name: /Evening mix/ }).click();
  await expect.poll(async () => (await data(request)).sent.some((s) => s.route === 'spotify' && s.action === 'play'
    && s.uri === 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' && s.device === 'echo')).toBe(true);
  await page.waitForTimeout(3200);
  expect((await data(request)).sent.filter((s) => s.route === 'playlists')).toHaveLength(1);
  await page.getByRole('button', { name: 'More playlists', exact: true }).click();
  await expect(page.getByRole('button', { name: /Morning mix/ })).toBeVisible();
  expect((await data(request)).sent.filter((s) => s.route === 'playlists').map((s) => s.offset)).toEqual(['0', '50']);
  await page.getByRole('button', { name: /Morning mix/ }).click();
  await expect.poll(async () => (await data(request)).sent.some((s) => s.route === 'spotify' && s.action === 'play'
    && s.uri === 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd' && s.device === 'echo')).toBe(true);
  await page.screenshot({ path: `test-results/spotify-${test.info().project.name}.png` });
});

for (const error of ['Spotify is busy. Try again in a moment.', 'Spotify cannot be reached.']) {
  test(`Spotify keeps playlists and restores its hint after: ${error}`, async ({ page }) => {
    await page.locator('.tile.speaker').click();
    const playlist = page.getByRole('button', { name: /Evening mix/ });
    await expect(playlist).toBeVisible();
    const fail = (route) => route.fulfill({ json: { available: false, backend: 'none', canTransfer: false, error } });
    await page.route('**/api/spotify', fail);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.spotify-library-note')).toHaveText(error);
    await expect(playlist).toBeVisible();
    await expect(playlist).toBeDisabled();
    await page.unroute('**/api/spotify', fail);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.spotify-library-note')).toHaveText('Choose a playlist to play on the selected speaker.');
    await expect(playlist).toBeEnabled();
  });
}

test('removing a preset TV app persists through reload and leaves the TV unchanged', async ({ page, request }) => {
  await page.locator('.scene[data-key="movie"]').click({ button: 'right' });
  await page.getByText('Edit', { exact: true }).click();
  await page.getByLabel('Studio TV app', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await data(request)).plan.scenes.find((s) => s.id === 'movie')?.tvs ?? null).toBe(null);
  await page.reload();
  await page.locator('.scene[data-key="movie"]').click();
  await expect.poll(async () => (await data(request)).sent.some((s) => s.kind === 'ac' && s.patch?.target === 72)).toBe(true);
  const sent = (await data(request)).sent;
  expect(sent.some((s) => s.kind === 'light' && s.patch?.brightness === 0.2)).toBe(true);
  expect(sent.some((s) => s.route === 'tv')).toBe(false);
  await page.locator('.scene[data-key="movie"]').click({ button: 'right' });
  await page.getByText('Edit', { exact: true }).click();
  await expect(page.getByLabel('Studio TV app', { exact: true })).toHaveValue('');
});

test('the 3D speaker has a finite hover anchor and opens its remote', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop hover');
  await page.getByRole('button', { name: 'Show the home', exact: true }).click();
  await expect(page.locator('.stage canvas')).toHaveCSS('opacity', '1');
  await page.waitForTimeout(500);
  const point = await page.evaluate(() => {
    window.__house.world.settle();
    const p = window.__house.world.screenAnchor({ kind: 'speaker', id: 'spotify' });
    const r = document.querySelector('.stage canvas').getBoundingClientRect();
    return { x: r.x + p.x, y: r.y + p.y };
  });
  expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.tooltip.show')).toContainText('Studio speaker');
  const position = await page.locator('.tooltip').evaluate((e) => ({ x: parseFloat(e.style.left), y: parseFloat(e.style.top) }));
  expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.sheet-name')).toHaveText('Spotify');
});

test('the desktop island opens AC controls without toggling power', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'Desktop island');
  await page.goto('/?mode=island&expanded=1');
  await expect(page.locator('.isle')).toHaveAttribute('data-state', 'expanded');
  await page.waitForFunction(() => Boolean(window.__house?.world));
  await page.waitForTimeout(800);
  const point = await page.evaluate(() => {
    window.__house.world.settle();
    const p = window.__house.world.screenAnchor({ kind: 'ac', id: 'studio.ac' });
    const r = document.querySelector('.isle-stage canvas').getBoundingClientRect();
    return { x: r.x + p.x, y: r.y + p.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.sheet-name')).toContainText('AC');
  expect((await data(request)).sent.some((s) => s.kind === 'ac')).toBe(false);
});

test('launcher styling stays round and readable in both appearances', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const theme of ['dark', 'light']) {
    await page.evaluate((choice) => { localStorage.setItem('house.theme', choice); }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.reload();
    await expect(page.locator('.tile.tv')).toBeVisible();
    await page.waitForFunction(() => Boolean(window.__house?.world) && document.querySelector('canvas').width > 100);
    await expect(page.locator('.stage canvas')).toHaveCSS('opacity', '1');
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.__house.world.resize();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__house.world.settle();
    });
    const radius = await page.locator('.tile.ac .bubble').evaluate((e) => getComputedStyle(e).borderRadius);
    expect(radius).toBe('50%');
    await page.screenshot({ path: `test-results/home-${test.info().project.name}-${theme}.png` });
  }
  expect(errors).toEqual([]);
});

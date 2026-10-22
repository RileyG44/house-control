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
  await page.screenshot({ path: `test-results/spotify-${test.info().project.name}.png` });
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

import { test, expect, type Page } from '@playwright/test';

// Explicit API fixtures for tests only. No simulated responses are installed in
// the application's live mode.
const fixture = {
  hospitals: { '0': { id: 0, name: 'Test Hospital', numSamples: 12, device: 'CPU' } },
  rounds: {
    '1': { round: 1, phase: 'finalized', submissions: { '0': { hospitalId: 0, status: 'accepted', offchain: 'accepted', onchain: 'accepted' } }, metrics: { '0': { dice: 0.25, val_loss: 0.5 } } },
    '2': { round: 2, phase: 'finalized', newGlobalModelHash: `0x${'a'.repeat(64)}`, finalizeTx: { block: 99, txHash: `0x${'b'.repeat(64)}` }, submissions: { '0': { hospitalId: 0, status: 'accepted', offchain: 'accepted', onchain: 'accepted' } }, metrics: { '0': { dice: 0, val_loss: 0 } } },
  },
  chain: { enabled: true, chainId: 31337, registry: `0x${'c'.repeat(40)}` },
  zk: { chunkSize: 8, constraints: 1000 }, events: [],
};
const live = async (page: Page) => page.getByLabel('Telemetry data source').selectOption('live');

test('all exported sections render without broken assets, remote fonts, or demo API calls', async ({ page }) => {
  const errors: string[] = [], failures: string[] = [], apis: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', r => failures.push(r.url()));
  page.on('request', r => { if (r.url().includes('/api/')) apis.push(r.url()); });
  await page.goto('/');
  for (const id of ['hero-studio', 'workflow', 'fl-command', 'workstation', 'zk-lab', 'ledger', 'simulator']) await expect(page.locator(`#${id}`)).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Intelligence Without Exposure.' })).toBeVisible();
  await expect(page.locator('.brain-viewport canvas')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('500 16px "Space Grotesk"'))).toBeTruthy();
  expect(apis).toEqual([]); expect(errors).toEqual([]); expect(failures).toEqual([]);
});

test('desktop navigation reaches the original sections', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'ZK Lab' }).click();
  await expect(page).toHaveURL(/#zk-lab$/);
  await expect(page.getByRole('heading', { name: 'Zero-Knowledge Verification Lab' })).toBeInViewport();
});

test('mobile menu, narrow layouts and mask controls remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('link', { name: 'FL Command' }).click();
  await expect(page.getByRole('navigation', { name: 'Mobile navigation', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('#workstation').scrollIntoViewIfNeeded();
  await page.getByRole('slider', { name: 'Tumor Mask Opacity Control' }).fill('23');
  await expect(page.locator('output')).toHaveText('23%');
  for (let i = 0; i < 3; i++) await expect(page.getByTestId(`mask-${i}`)).toHaveAttribute('opacity', '0.23');
  await page.getByRole('button', { name: 'FLAIR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'FLAIR', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('img', { name: /AXIAL FLAIR schematic/ })).toBeVisible();
});

test('brain modes, camera controls, and reset work without runtime errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.brain-viewport canvas')).toBeVisible();
  const beforeZoom = await page.locator('.brain-viewport canvas').screenshot();
  await page.getByRole('button', { name: 'Zoom in on brain', exact: true }).click();
  const afterZoom = await page.locator('.brain-viewport canvas').screenshot();
  expect(afterZoom.equals(beforeZoom)).toBeFalsy();
  await page.getByRole('button', { name: 'Synaptic Pathways', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Synaptic Pathways', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Zoom in on brain', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate brain right', exact: true }).click();
  await page.getByRole('button', { name: 'Reset Camera Orientation', exact: true }).click();
  await expect(page.locator('.brain-viewport canvas')).toBeVisible();
  expect(errors).toEqual([]);
});

test('workflow and nine-stage tour advance and pause', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Simulate Protocol Workflow', exact: true }).click();
  await expect(page.getByRole('button', { name: /Demo step/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Next simulation stage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stage 2: Local 3D U-Net Training' })).toBeVisible();
  await page.getByRole('button', { name: '9. Clinical', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stage 9: Clinical Inference Delivery' })).toBeVisible();
  await page.getByRole('button', { name: 'Auto Tour', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause Tour', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stage 1: Global Model Distribution' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause Tour', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auto Tour', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('proof animation is labeled and never sends a transaction', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', r => { if (r.method() !== 'GET') mutations.push(r.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Simulate Proof Generation', exact: true }).click();
  await expect(page.getByText('DEMO · Proof generation animation complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Simulate On-Chain Check', exact: true }).click();
  await expect(page.getByText('DEMO · Verification animation complete', { exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('live API uses actual fixture metrics including zero and suppresses sample hospitals', async ({ page }) => {
  await page.route('**/api/state', route => route.fulfill({ json: fixture }));
  await page.goto('/'); await live(page);
  await expect(page.getByRole('heading', { name: 'Test Hospital', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Johns Hopkins Medical Center', exact: true })).toHaveCount(0);
  await expect(page.locator('#fl-command').getByText('0.000', { exact: true })).toHaveCount(4);
  await expect(page.getByTestId('model-hash')).toHaveText(fixture.rounds['2'].newGlobalModelHash);
  await expect(page.getByText('BLOCK #99', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Simulation', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Simulate Proof Generation', exact: true })).toBeDisabled();
});

test('API failure clears live values without filling them with demo metrics', async ({ page }) => {
  let fail = false;
  await page.route('**/api/state', route => fail ? route.fulfill({ status: 503, json: { error: 'offline' } }) : route.fulfill({ json: fixture }));
  await page.goto('/'); await live(page);
  await expect(page.getByRole('heading', { name: 'Test Hospital', exact: true })).toBeVisible();
  fail = true;
  await page.getByRole('button', { name: 'Refresh Telemetry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP 503');
  await expect(page.getByText('No live hospital telemetry available.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('model-hash')).toHaveText('Not available');
  await expect(page.locator('#fl-command').getByText('0.914', { exact: true })).toHaveCount(0);
});

test('malformed API response and empty state render honest errors or empty views', async ({ page }) => {
  await page.route('**/api/state', route => route.fulfill({ json: { unrelated: true } }));
  await page.goto('/'); await live(page);
  await expect(page.getByRole('alert')).toContainText('Unexpected trust-layer response');
  await page.unroute('**/api/state');
  await page.route('**/api/state', route => route.fulfill({ json: { ...fixture, hospitals: {}, rounds: {} } }));
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByText('No hospitals registered in the trust layer.', { exact: true })).toBeVisible();
  await expect(page.getByText('No dice measurements reported.', { exact: true })).toBeVisible();
});

test('copy action writes the displayed full hash to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Model Hash', exact: true }).click();
  const root = await page.getByTestId('model-hash').textContent();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(root);
  await expect(page.getByRole('button', { name: 'Hash Copied!', exact: true })).toBeVisible();
});

test('dialogs support Escape and reduced-motion preference disables smooth scroll', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connection status', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
});

test('tablet, compact mobile, and desktop layouts have no horizontal overflow', async ({ page }) => {
  await page.goto('/');
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`).toBeTruthy();
  }
});

test('missing WebGL leaves an accessible static illustration and working dashboard', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof original>) {
      if (String(args[0]).includes('webgl')) return null;
      return original.apply(this, args);
    } as typeof original;
  });
  await page.goto('/');
  await expect(page.getByText('WebGL unavailable · Static illustration', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Federated Weights', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Federated Weights', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'Ledger', exact: true }).click();
  await expect(page).toHaveURL(/#ledger$/);
});

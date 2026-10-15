// 网站无运行依赖；此端到端测试在已提供 Playwright 的开发环境运行。
// node --test tests/backup.test.cjs
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const playwright = require('playwright');

const KEY = 'phrase-pocket-v1';
const records = [
  { id: 'restore-1', english: 'Keep going. 🌱', meaning: '继续加油。', notes: '备注\n换行和 "引号"', mastered: false, favorite: true },
  { id: 'restore-2', english: '<b>Take your time.</b>', meaning: '慢慢来。', notes: '', mastered: true, favorite: false }
];
const backup = (phrases = records) => ({ app: 'phrase-pocket', version: 1, exportedAt: '2026-10-15T08:00:00.000Z', phrases });
let browser, server, url, context, page, errors;
const cards = () => page.locator('#phrase-list article');
const status = () => page.locator('#backup-status').textContent();
const raw = () => page.evaluate(key => localStorage.getItem(key), KEY);
const storage = async () => JSON.parse(await raw());
const chooseText = (text, name = 'backup.json') => page.locator('#backup-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
async function choose(data = backup()) {
  await chooseText(JSON.stringify(data));
  await page.locator('#backup-preview').waitFor({ state: 'visible' });
}
async function seedOriginal() {
  // 用原有 UI 生成真实的本地记录，避免仅验证模拟存储。
  await cards().first().locator('.favorite').click();
  return raw();
}
async function confirm(accept = true) {
  page.once('dialog', async d => { if (accept) await d.accept(); else await d.dismiss(); });
  await page.locator('#confirm-import').click();
  await page.locator('#backup-preview').waitFor({ state: 'hidden' });
}
async function exported() {
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-backup').click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^phrase-pocket-backup-.*\.json$/);
  const text = await fs.readFile(await download.path(), 'utf8');
  return JSON.parse(text);
}
async function unchanged(original) {
  assert.equal(await raw(), original);
  assert.equal(await cards().count(), 3);
  assert.equal(await cards().first().locator('h3').textContent(), "It's worth a shot.");
}

before(async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  const engine = process.env.TEST_BROWSER || 'chromium';
  browser = await playwright[engine].launch(engine === 'chromium' ? { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] } : {});
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
beforeEach(async () => {
  context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage(); errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  // 下载分支在所有引擎下确定执行；系统分享分支另有专门测试。
  await page.evaluate(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }));
});
afterEach(async () => {
  assert.deepEqual(errors, [], '页面不应有未捕获的异常');
  await context.close();
});

test('导出真实 JSON 下载：包含全部字段，不受筛选影响，不改动原数据', async () => {
  const original = await seedOriginal();
  await page.locator('#favorites-only').click();
  await page.locator('#search').fill('no match');
  const data = await exported();
  assert.equal(data.app, 'phrase-pocket'); assert.equal(data.version, 1);
  assert.ok(Number.isFinite(Date.parse(data.exportedAt)));
  assert.deepEqual(data.phrases, JSON.parse(original));
  assert.equal(await raw(), original);
});

test('导出失败时原数据不变，显示错误并重新启用按钮', async () => {
  const original = await seedOriginal();
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('无法生成下载文件'); }; });
  await page.locator('#export-backup').click();
  assert.match(await status(), /导出失败.*无法生成下载文件/);
  assert.equal(await page.locator('#export-backup').isEnabled(), true);
  await unchanged(original);
});

test('重复导出生成最新快照，后备下载链接更新为最新文件', async () => {
  await seedOriginal(); const first = await exported();
  const firstURL = await page.locator('#backup-download').getAttribute('href');
  await cards().nth(1).locator('.favorite').click();
  const second = await exported();
  assert.equal(first.phrases[1].favorite, false); assert.equal(second.phrases[1].favorite, true);
  assert.notEqual(await page.locator('#backup-download').getAttribute('href'), firstURL);
  assert.deepEqual(second.phrases, await storage());
});

test('选择文件按钮、数量预览和取消：取消前后 localStorage 与列表完全不变', async () => {
  const original = await seedOriginal();
  const chooserEvent = page.waitForEvent('filechooser');
  await page.locator('#import-backup').click();
  const chooser = await chooserEvent;
  await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup())) });
  await page.locator('#backup-preview').waitFor({ state: 'visible' });
  assert.match(await page.locator('#backup-summary').textContent(), /2 条表达（已掌握 1 条，星标 1 条）.*当前 3 条/);
  await unchanged(original);
  await page.locator('#cancel-import').click();
  await unchanged(original); await page.reload(); await unchanged(original);
});

test('最终确认框取消，不替换原数据', async () => {
  const original = await seedOriginal(); await choose();
  let message;
  page.once('dialog', async d => { message = d.message(); await d.dismiss(); });
  await page.locator('#confirm-import').click();
  assert.match(message, /2 条表达替换当前 3 条/);
  assert.match(await status(), /已取消/);
  await unchanged(original); await page.reload(); await unchanged(original);
});

test('确认恢复、真实 reload、星标筛选、掌握筛选、搜索及复习均可继续使用', async () => {
  await page.locator('#draw').click();
  await page.locator('#search').fill('no match'); await page.locator('#favorites-only').click();
  await choose(); await confirm();
  assert.deepEqual(await storage(), records);
  assert.equal(await cards().count(), 2);
  assert.equal(await page.locator('#practice-card .en').count(), 0);
  assert.equal(await page.locator('#reveal').isHidden(), true);
  assert.equal(await page.locator('#search').inputValue(), '');
  assert.equal(await page.locator('#favorites-only').getAttribute('aria-pressed'), 'false');
  await page.reload(); assert.deepEqual(await storage(), records);
  assert.equal(await page.locator('#total-count').textContent(), '2');
  assert.equal(await page.locator('#mastered-count').textContent(), '1');
  assert.equal(await cards().nth(1).locator('b').count(), 0, '备份文字不能变成 HTML');
  await page.locator('#favorites-only').click();
  assert.deepEqual(await cards().locator('h3').allTextContents(), [records[0].english]);
  await page.locator('#favorites-only').click();
  await page.locator('[data-filter="mastered"]').click();
  assert.deepEqual(await cards().locator('h3').allTextContents(), [records[1].english]);
  await page.locator('[data-filter="all"]').click(); await page.locator('#search').fill('引号');
  assert.equal(await cards().count(), 1);
  await page.locator('#draw').click(); await page.locator('#reveal').click();
  assert.equal(await page.locator('#practice-card .zh').textContent(), records[0].meaning);
});

test('导出 → 修改数据 → 导入原备份 → reload 完整往返，无字段丢失', async () => {
  await seedOriginal(); const data = await exported();
  await page.locator('#english').fill('Extra phrase'); await page.locator('#meaning').fill('新增');
  await page.locator('#phrase-form button').click(); assert.equal(await cards().count(), 4);
  await choose(data); await confirm(); await page.reload();
  assert.deepEqual(await storage(), data.phrases);
  assert.equal(await cards().count(), 3);
});

test('空备份明确警告，取消不清空，确认后才清空并持久保存，仍能导出', async () => {
  const original = await seedOriginal(); await choose(backup([]));
  assert.match(await page.locator('#backup-summary').textContent(), /空备份.*清空/);
  await confirm(false); await unchanged(original);
  await choose(backup([])); await confirm(); await page.reload();
  assert.deepEqual(await storage(), []); assert.equal(await cards().count(), 0);
  assert.deepEqual((await exported()).phrases, []);
});

const invalidFiles = [
  ['损坏 JSON', '{"app":'], ['空文件', ''], ['null', 'null'], ['普通数组', JSON.stringify(records)],
  ['错误来源', JSON.stringify({ ...backup(), app: 'other' })],
  ['未知版本', JSON.stringify({ ...backup(), version: 2 })],
  ['错误日期', JSON.stringify({ ...backup(), exportedAt: 'broken' })],
  ['表达列表类型错误', JSON.stringify({ ...backup(), phrases: {} })],
  ['混入无效记录', JSON.stringify(backup([records[0], null]))],
  ['重复 ID', JSON.stringify(backup([records[0], records[0]]))],
  ['空 ID', JSON.stringify(backup([{ ...records[0], id: ' ' }]))],
  ['空英语', JSON.stringify(backup([{ ...records[0], english: ' ' }]))],
  ['缺失中文', JSON.stringify(backup([{ ...records[0], meaning: undefined }]))],
  ['备注类型错误', JSON.stringify(backup([{ ...records[0], notes: 1 }]))],
  ['掌握状态类型错误', JSON.stringify(backup([{ ...records[0], mastered: 'true' }]))],
  ['星标字段缺失', JSON.stringify(backup([{ ...records[0], favorite: undefined }]))]
];
for (const [name, text] of invalidFiles) {
  test(`拒绝${name}：不显示确认预览，不覆盖任何记录`, async () => {
    const original = await seedOriginal(); await chooseText(text);
    await page.waitForFunction(() => document.getElementById('backup-status').classList.contains('error'));
    assert.equal(await page.locator('#backup-preview').isHidden(), true);
    await unchanged(original); await page.reload(); await unchanged(original);
  });
}

test('UTF-8 BOM 备份可恢复，文件扩展名和 MIME 不替代内容校验', async () => {
  await chooseText('\uFEFF' + JSON.stringify(backup()), 'backup.txt');
  await page.locator('#backup-preview').waitFor({ state: 'visible' });
  await confirm(); assert.deepEqual(await storage(), records);
});

test('超过 5 MB 的文件被拒绝，旧数据保持不变', async () => {
  const original = await seedOriginal();
  await chooseText(' '.repeat(5 * 1024 * 1024 + 1));
  await page.waitForFunction(() => document.getElementById('backup-status').textContent.includes('超过 5 MB'));
  await unchanged(original);
});

test('新选文件损坏时，旧预览失效；再次选同一有效文件仍可预览', async () => {
  const original = await seedOriginal(); await choose(); await chooseText('{');
  await page.waitForFunction(() => document.getElementById('backup-status').classList.contains('error'));
  assert.equal(await page.locator('#backup-preview').isHidden(), true);
  await page.evaluate(() => document.getElementById('confirm-import').click());
  await unchanged(original);
  await choose(); await page.locator('#cancel-import').click(); await choose();
  await unchanged(original);
});

test('未选文件或取消文件选择，不修改数据', async () => {
  const original = await seedOriginal(); await page.locator('#backup-file').setInputFiles([]);
  await unchanged(original); assert.equal(await page.locator('#backup-preview').isHidden(), true);
});

test('读取文件失败时显示错误，原数据不变', async () => {
  const original = await seedOriginal();
  await page.evaluate(() => { FileReader.prototype.readAsText = function () { queueMicrotask(() => this.dispatchEvent(new Event('error'))); }; });
  await chooseText(JSON.stringify(backup()));
  await page.waitForFunction(() => document.getElementById('backup-status').textContent.includes('无法读取'));
  await unchanged(original);
});

test('localStorage 写入失败：确认后仍保留原页面及存储，刷新无损', async () => {
  const original = await seedOriginal(); await choose();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('容量不足', 'QuotaExceededError'); }; });
  await confirm(); assert.match(await status(), /恢复失败.*容量不足/);
  await unchanged(original);
  assert.deepEqual((await exported()).phrases, JSON.parse(original), '内存也必须保留旧数据');
  await page.reload(); await unchanged(original);
});

test('localStorage 读取失败时不允许进入恢复预览', async () => {
  const original = await seedOriginal();
  await page.evaluate(() => { Storage.prototype.getItem = () => { throw new DOMException('禁止读取', 'SecurityError'); }; });
  await chooseText(JSON.stringify(backup()));
  await page.waitForFunction(() => document.getElementById('backup-status').classList.contains('error'));
  assert.equal(await cards().count(), 3); await page.reload(); await unchanged(original);
});

test('预览后在当前页面添加表达，拒绝覆盖刚添加的数据', async () => {
  await seedOriginal(); await choose();
  await page.locator('#english').fill('Just added'); await page.locator('#meaning').fill('刚添加的');
  await page.locator('#phrase-form button').click();
  const latest = await raw(); await page.locator('#confirm-import').click();
  assert.match(await status(), /数据已变化/); assert.equal(await raw(), latest);
  assert.equal(await cards().count(), 4);
});

for (const duringDialog of [false, true]) {
  test(`其他标签页在${duringDialog ? '最终确认框打开时' : '预览之后'}修改数据，拒绝覆盖`, async () => {
    await seedOriginal(); await choose();
    const other = await context.newPage(); await other.goto(url);
    const newer = JSON.stringify([{ ...records[0], english: 'Saved in another tab' }]);
    if (duringDialog) {
      page.once('dialog', async d => { await other.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: KEY, value: newer }); await d.accept(); });
    } else {
      await other.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: KEY, value: newer });
    }
    await page.locator('#confirm-import').click();
    await page.locator('#backup-preview').waitFor({ state: 'hidden' });
    assert.match(await status(), /数据已变化/); assert.equal(await raw(), newer);
    assert.equal(await cards().count(), 3); await page.reload();
    assert.equal(await cards().first().locator('h3').textContent(), 'Saved in another tab');
  });
}

test('其他标签页在选择文件前已修改数据，不允许基于旧页面预览覆盖', async () => {
  await seedOriginal();
  const other = await context.newPage(); await other.goto(url);
  const newer = JSON.stringify(records);
  await other.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: KEY, value: newer });
  await chooseText(JSON.stringify(backup()));
  await page.waitForFunction(() => document.getElementById('backup-status').classList.contains('error'));
  assert.match(await status(), /其他标签页已修改数据/);
  assert.equal(await page.locator('#backup-preview').isHidden(), true);
  assert.equal(await raw(), newer);
});

test('旧版本地记录缺少 favorite 时，导出规范化字段后可完整恢复', async () => {
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify([{ id: 'legacy', english: 'Old phrase', meaning: '旧数据', mastered: true }])), KEY);
  await page.reload();
  const data = await exported();
  assert.deepEqual(data.phrases, [{ id: 'legacy', english: 'Old phrase', meaning: '旧数据', notes: '', mastered: true, favorite: false }]);
  await choose(data); await confirm(); await page.reload(); assert.deepEqual(await storage(), data.phrases);
});

for (const outcome of ['success', 'cancel', 'error']) {
  test(`文件分享分支（模拟系统接口）：${outcome}，下载后备链接始终可用`, async () => {
    const original = await seedOriginal();
    await page.evaluate(outcome => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: ({ files }) => files[0] instanceof File });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }) => {
        window.sharedBackup = JSON.parse(await files[0].text());
        if (outcome !== 'success') throw new DOMException('Test share', outcome === 'cancel' ? 'AbortError' : 'NotAllowedError');
      } });
    }, outcome);
    await page.locator('#export-backup').click();
    await page.waitForFunction(() => !document.getElementById('export-backup').disabled);
    assert.deepEqual((await page.evaluate(() => window.sharedBackup)).phrases, JSON.parse(original));
    assert.match(await status(), outcome === 'success' ? /已完成分享操作/ : outcome === 'cancel' ? /已取消分享/ : /分享未完成/);
    const downloadEvent = page.waitForEvent('download'); await page.locator('#backup-download').click();
    const download = await downloadEvent;
    assert.deepEqual(JSON.parse(await fs.readFile(await download.path(), 'utf8')).phrases, JSON.parse(original));
    await unchanged(original);
  });
}

test('手机尺寸操作备份恢复、恢复后的添加和删除仍正常，无横向溢出', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await choose(); await confirm(); await page.reload(); assert.deepEqual(await storage(), records);
  await cards().first().locator('.favorite').click();
  assert.equal((await storage())[0].favorite, false);
  await cards().first().getByRole('button', { name: '标记为已掌握', exact: true }).click();
  assert.equal((await storage())[0].mastered, true);
  await page.locator('#favorites-only').click();
  await page.locator('#english').fill('New phrase'); await page.locator('#meaning').fill('新表达');
  await page.locator('#phrase-form button').click(); assert.equal(await cards().count(), 3);
  page.once('dialog', d => d.accept());
  await cards().first().getByRole('button', { name: /^删除：/ }).click();
  await page.reload(); assert.equal(await cards().count(), 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

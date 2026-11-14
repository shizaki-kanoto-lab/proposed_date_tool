/**
 * 公開ページの約束事が崩れていないことを確認する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');

const html = read('index.html');
const app = read('app.js');


test('CSP に反するインラインの処理と指定がない', () => {
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html.replace(/<script[^>]*src=[^>]*><\/script>/g, ''), /<script/i);
  assert.doesNotMatch(app, /\son[a-z]+=["']/i);
  assert.doesNotMatch(app, /\sstyle=["']/i);
});


test('外部通信は Google のログインと Calendar API のみ', () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const hosts = new Set(csp.match(/https:\/\/[^\s;/]+/g));

  assert.deepEqual([...hosts].sort(), ['https://accounts.google.com', 'https://www.googleapis.com']);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe/);
});


test('GAS の呼び出しが残っていない', () => {
  assert.doesNotMatch(app, /google\.script/);
});


test('トークンをブラウザに保存しない', () => {
  assert.doesNotMatch(read('calendar-api.js'), /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.equal(app.match(/localStorage\.setItem/g).length, 1);
  assert.match(app, /'proposedDateSettings'/);
});


test('画面の要素が app.js の参照先とそろっている', () => {
  const ids = [...app.matchAll(/getElementById\(\s*'([^']+)'/g)].map(match => match[1]);

  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), id);
  }

  for (const id of ['loginButton', 'searchButton', 'copyButton', 'clearButton', 'checkAllButton', 'uncheckAllButton', 'zeroPad', 'monthDayOnly', 'includeTime']) {
    assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(app.includes(id), id);
  }
});


test('アイコンとファビコンの画像がすべて web/ にある', () => {
  const paths = [...html.matchAll(/(?:href|src)="(icons\/[^"]+)"/g)].map(match => match[1]);

  assert.equal(paths.length, 4);

  for (const path of paths) {
    assert.ok(fs.existsSync(new URL(`../web/${path}`, import.meta.url)), path);
  }
});


test('プライバシーポリシーはスクリプトを読み込まず、トップから辿れる', () => {
  const policy = read('privacy.html');

  assert.ok(policy.includes('href="terms.html"'));
  const csp = policy.match(/Content-Security-Policy" content="([^"]+)"/)[1];

  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(!csp.includes('script-src'));
  assert.ok(!/<script\b/i.test(policy));
  assert.ok(html.includes('href="privacy.html"'));
  assert.ok(policy.includes('calendar.calendarlist.readonly'));
  assert.ok(policy.includes('calendar.events.owned.readonly'));
});


test('プライバシーポリシーに情報の保護の節と英語版がある', () => {
  const policy = read('privacy.html');

  assert.ok(policy.includes('情報の保護'));
  assert.ok(policy.includes('id="en" lang="en"'));
  assert.ok(policy.includes('href="#en"'));
  assert.ok(policy.includes('Data protection'));
  assert.ok(policy.includes('Limited Use requirements'));
});


test('利用規約はスクリプトを読み込まず、トップから辿れる', () => {
  const terms = read('terms.html');
  const csp = terms.match(/Content-Security-Policy" content="([^"]+)"/)[1];

  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(!csp.includes('script-src'));
  assert.ok(!/<script\b/i.test(terms));
  assert.ok(html.includes('href="terms.html"'));
  assert.ok(terms.includes('href="privacy.html"'));
});


test('リンクを共有したときのカード（OGP）の画像が web/ にある', () => {
  const image = /property="og:image" content="([^"]+)"/.exec(html)[1];
  const base = 'https://shizaki-kanoto.is-a.dev/proposed_date_tool/';

  assert.ok(image.startsWith(base), image);
  assert.ok(fs.existsSync(new URL(`../web/${image.slice(base.length)}`, import.meta.url)));
  assert.match(html, /property="og:url" content="https:\/\/shizaki-kanoto\.is-a\.dev\/proposed_date_tool\/"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
});

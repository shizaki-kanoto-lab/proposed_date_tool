#!/usr/bin/env node
/**
 * リポジトリ内のファイルが正しく読み込める状態かを確認する簡易チェック。
 * - appsscript.json が正しいJSONか
 * - src/Code.js の構文が正しいか
 * - src/index.html 内の <script> の構文が正しいか
 * - src/index.html のタグが対応しているか
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', 'src');

let hasError = false;

function fail(message) {
  console.error(`✗ ${message}`);
  hasError = true;
}

function pass(message) {
  console.log(`✓ ${message}`);
}

/* ========== appsscript.json ========== */

try {
  const manifestPath = path.join(ROOT, 'appsscript.json');
  JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  pass('appsscript.json is valid JSON');
} catch (error) {
  fail(`appsscript.json is invalid: ${error.message}`);
}

/* ========== Code.js ========== */

try {
  const codePath = path.join(ROOT, 'Code.js');
  execFileSync(process.execPath, ['--check', codePath], { stdio: 'pipe' });
  pass('Code.js syntax is valid');
} catch (error) {
  fail(`Code.js has a syntax error:\n${error.stderr}`);
}

/* ========== index.html: inline <script> syntax ========== */

const htmlPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

if (!scriptMatch) {
  fail('index.html has no <script> block to check');
} else {
  const tmpFile = path.join(os.tmpdir(), 'index-inline-script.js');
  fs.writeFileSync(tmpFile, scriptMatch[1]);

  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
    pass('index.html inline <script> syntax is valid');
  } catch (error) {
    fail(`index.html inline <script> has a syntax error:\n${error.stderr}`);
  }
}

/* ========== index.html: tag balance ========== */
/*
 * <script> と <style> の中身はJS/CSSであり、
 * < や > を含んでいてもタグとして扱わないため、
 * タグ対応チェックの対象からは除外する。
 */

const htmlForTagCheck = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');

const VOID_TAGS = new Set(['input', 'br', 'meta', 'base', 'img', 'hr']);
const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>/g;

const stack = [];
let match;

while ((match = tagPattern.exec(htmlForTagCheck)) !== null) {
  const isClosing = match[1] === '/';
  const tagName = match[2].toLowerCase();

  if (VOID_TAGS.has(tagName)) {
    continue;
  }

  if (!isClosing) {
    stack.push(tagName);
    continue;
  }

  const top = stack.pop();

  if (top !== tagName) {
    fail(
      `index.html has a mismatched tag: expected </${top}> but found </${tagName}>`
    );
    stack.length = 0;
    break;
  }
}

if (stack.length > 0) {
  fail(`index.html has unclosed tags: ${stack.join(', ')}`);
} else if (!hasError) {
  pass('index.html tags are balanced');
}

/* ========== 結果 ========== */

if (hasError) {
  console.error('\nValidation failed.');
  process.exit(1);
}

console.log('\nAll checks passed.');

import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LINK_CASES, LINK_CASE_KEEP, SLOW_INPUTS } from './helpers/link-cases.js';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function load() {
  const start = html.indexOf('  function readableUrl(url) {');
  const end = html.indexOf('  // --- Questions ---');
  assert.ok(start > 0 && end > start, 'anchors not found');
  // Matches the DOM-based esc: & < > only, quotes untouched.
  const ctx: Record<string, any> = { esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

const ctx = load();
const A = (href: string, label: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

for (const c of LINK_CASES) {
  test(`dashboard linkify matches the shared rules: ${c.name}`, () => {
    assert.equal(ctx.linkify(c.input, LINK_CASE_KEEP), c.output);
  });
}

test('a markdown link renders as an anchor that opens a new tab', () => {
  assert.equal(ctx.renderMarkdown('[문서](http://h/?a=1&b=2)'), A('http://h/?a=1&amp;b=2', '문서'));
});

test('quotes and angle brackets in links are escaped', () => {
  assert.equal(ctx.renderMarkdown('[<b>](http://h/"q)'), A('http://h/&quot;q', '&lt;b&gt;'));
});

test('a bare url shows decoded text', () => {
  assert.equal(ctx.renderMarkdown('보기: http://h/?n=%EC%9D%B4.'), `보기: ${A('http://h/?n=%EC%9D%B4', 'http://h/?n=이')}.`);
});

test('urls inside code stay code and stars inside code stay literal', () => {
  assert.equal(ctx.renderMarkdown('`http://h/x` `a*b*c`'), '<code>http://h/x</code> <code>a*b*c</code>');
  assert.equal(ctx.renderMarkdown('```\nhttp://h/x\n```'), '<pre><code>http://h/x<br></code></pre>');
});

test('stars and underscores in a url do not become emphasis', () => {
  assert.equal(ctx.renderMarkdown('http://h/a*b*c'), A('http://h/a*b*c', 'http://h/a*b*c'));
});

const REGRESSION: Array<[string, string]> = [
  ['**굵게** 그리고 *기울임*', '<strong>굵게</strong> 그리고 <em>기울임</em>'],
  ['# 제목\n본문', '<h2>제목</h2>본문'],
  ['```js\nconst a = 1;\nconst b = 2;\n```\n다음 줄', '<pre><code>const a = 1;<br>const b = 2;<br></code></pre>다음 줄'],
  ['`x` 와 `y`', '<code>x</code> 와 <code>y</code>'],
  ['- 하나\n- 둘\n\n끝', '<ul><li>하나</li><li>둘</li></ul>끝'],
  ['| a | b |\n|---|---|\n| 1 | 2 |\n다음', '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>다음'],
  ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['줄1\n줄2', '줄1<br>줄2'],
];

for (const [input, output] of REGRESSION) {
  test(`markdown without links renders as before: ${JSON.stringify(input)}`, () => {
    assert.equal(ctx.renderMarkdown(input), output);
  });
}

test('links get a visible style in message bodies', () => {
  assert.match(html, /\.message-body a \{[^}]*color: var\(--blue\)/);
});

for (const s of SLOW_INPUTS) {
  test(`dashboard linkify stays fast: ${s.name}`, () => {
    const started = performance.now();
    ctx.linkify(s.input, LINK_CASE_KEEP);
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  });
}

test('inline code in a link title renders inside the anchor', () => {
  assert.equal(ctx.renderMarkdown('[`#123`](https://g/p/123)'), A('https://g/p/123', '<code>#123</code>'));
});

test('code right after a bare url stays out of the href', () => {
  assert.equal(ctx.renderMarkdown('http://h/x`code`'), `${A('http://h/x', 'http://h/x')}<code>code</code>`);
});

test('a bold bare url stays bold and links to the right address', () => {
  assert.equal(ctx.renderMarkdown('**http://h/x**'), `<strong>${A('http://h/x', 'http://h/x')}</strong>`);
});

test('placeholder-shaped text in the input is not replaced by kept parts', () => {
  assert.equal(ctx.renderMarkdown('\uE0000\uE001 `c`'), '\uFFFD0\uFFFD <code>c</code>');
});

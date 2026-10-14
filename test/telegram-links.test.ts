import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/hub/telegram.js';

const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
const md = (s: string): string => (bot as any).mdToHtml(s);

test('a markdown link becomes an anchor with an escaped href', () => {
  assert.equal(md('[문서](http://h/?a=1&b=2)'), '<a href="http://h/?a=1&amp;b=2">문서</a>');
});

test('a quote in the href is escaped', () => {
  assert.equal(md('[x](http://h/"q)'), '<a href="http://h/&quot;q">x</a>');
});

test('a bare url shows decoded text', () => {
  assert.equal(md('http://h/?n=%EC%9D%B4'), '<a href="http://h/?n=%EC%9D%B4">http://h/?n=이</a>');
});

test('urls inside code stay code', () => {
  assert.equal(md('`http://h/x`'), '<code>http://h/x</code>');
  assert.equal(md('```\nhttp://h/x\n```'), '<pre>http://h/x\n</pre>');
});

test('stars in a url do not turn into italics, bold around a link still works', () => {
  assert.equal(md('**[t](http://h/a*b*c)**'), '<b><a href="http://h/a*b*c">t</a></b>');
});

test('javascript links stay text', () => {
  assert.equal(md('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
});

test('formatting without links is unchanged', () => {
  assert.equal(md('# 제목\n**굵게** *기울임* `c`'), '<b>제목</b>\n<b>굵게</b> <i>기울임</i> <code>c</code>');
});

test('inline code in a link title shows as plain label text', () => {
  assert.equal(md('[`#123`](https://g/p/123)'), '<a href="https://g/p/123">#123</a>');
});

test('code right after a bare url stays out of the href', () => {
  assert.equal(md('http://h/x`code`'), '<a href="http://h/x">http://h/x</a><code>code</code>');
});

test('a bold bare url stays bold and links to the right address', () => {
  assert.equal(md('**http://h/x**'), '<b><a href="http://h/x">http://h/x</a></b>');
});

test('placeholder-shaped text in the input is not replaced by kept parts', () => {
  assert.equal(md('\u0000CODE0\u0000 `c`'), 'CODE0 <code>c</code>');
});

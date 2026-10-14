# 링크 후처리와 세션 토큰 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드·텔레그램에서 `[제목](주소)`와 그냥 적힌 주소를 누를 수 있는 링크로 보여 주고, 대시보드 세션 카드에 각 Claude 세션의 컨텍스트 토큰 수를 보여 준다.

**Architecture:** 링크 규칙은 순수 함수 `linkify`(TS: `src/shared/links.ts`, 대시보드: `index.html` 안의 같은 JS)로, 코드처럼 자리 표시자로 빼 둔 뒤 되돌린다. 토큰은 채널 서버가 세션 기록(`~/.claude/sessions`)과 대화 기록(`~/.claude/projects/<cwd>/<sessionId>.jsonl`)에서 계산해 `context_tokens` 메시지로 Hub에 보내고(기능 협상), Hub는 `SessionInfo.contextTokens`에 저장해 `session_updated`로 대시보드에 알린다.

**Tech Stack:** TypeScript(ESM, `.js` import 접미사), Node `node:test` + `tsx`, `ws`, 빌드 없는 단일 HTML 대시보드(`vm` 샌드박스로 시험)

**Spec:** `docs/superpowers/specs/2026-10-14-links-context-tokens-design.md`

## Global Constraints

- 시험 실행: 전체 `npm test`, 파일 하나 `node --import tsx --import ./test/isolate-home.ts --test test/<file>.test.ts`. 시험 파일 첫 import는 `import './isolate-home.js';`(HOME 격리)
- 링크로 바꾸는 주소는 `http://`·`https://`(대소문자 무시)만
- 코드 블록·인라인 코드 안은 링크로 바꾸지 않는다
- 토큰 계산: 뒤에서부터 `system`/`compact_boundary`면 0, `isSidechain === true`·`model === '<synthetic>'`·`usage` 없는 줄은 건너뜀, 첫 main 응답의 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. 없으면 `null`
- 대화 기록은 끝 1MB(`1024 * 1024`)만 읽는다
- 채널은 Hub가 `hub_info.features`에 `context_tokens`를 알릴 때만 보낸다
- 대시보드 표시: 1,000 미만 그대로, `999_500` 미만 `Math.round(n/1000)k`, 그 이상 `(n/1e6).toFixed(1)M`. 없음·0은 표시 안 함
- 주석: 기본 없음. 코드로 알 수 없는 것(비공개 형식 의존, 순서 함정)만 영어로
- 실제 Hub 실행은 HOME 격리(임시 HOME, 다른 포트). `node.exe` 일괄 종료 금지 — 띄운 PID만 종료

## Review Focus

- 쿼리에 `&`·`"`가 든 주소: `href` 속성이 깨지지 않아야 한다 → Task 2·3 시험
- Hub 재시작·재연결 뒤 카드의 숫자가 사라진 채로 남지 않아야 한다 → Task 6 `reset` 시험
- `/clear`로 `sessionId`가 바뀐 세션: 새 대화 기록을 따라가야 한다 → Task 4 소켓 매칭 시험
- 1MB보다 큰 대화 기록과 잘린 첫 줄: 오류 없이 마지막 응답을 읽어야 한다 → Task 4 큰 파일 시험
- 세션 기록의 `sessionId`에 경로 문자(`..`, `/`)가 들어 있을 때: 다른 파일을 읽지 않고 `null` → Task 4 시험

---

### Task 1: 공용 링크 규칙 `linkify`

**Files:**
- Create: `src/shared/links.ts`
- Create: `test/helpers/link-cases.ts`
- Test: `test/links.test.ts`

**Interfaces:**
- Produces: `linkify(text: string, keep: (href: string, label: string) => string): string`, `readableUrl(url: string): string`. `test/helpers/link-cases.ts`의 `LINK_CASES: Array<{ name: string; input: string; output: string }>`(출력은 `keep = (h, l) => \`{${h}|${l}}\`` 기준) — Task 3이 대시보드 JS에 같은 목록을 돌린다

- [ ] **Step 1: 시험 사례 목록 작성**

`test/helpers/link-cases.ts`:

```ts
// Shared by test/links.test.ts (TypeScript) and test/dashboard-links.test.ts (dashboard copy) so both stay identical.
export const LINK_CASE_KEEP = (href: string, label: string) => `{${href}|${label}}`;

export const LINK_CASES: Array<{ name: string; input: string; output: string }> = [
  { name: 'markdown link shows its title', input: '[문서](http://a.b/x?y=1&z=2) 끝', output: '{http://a.b/x?y=1&z=2|문서} 끝' },
  { name: 'bare url shows the decoded text', input: 'see http://h/?note=%EC%9D%B4 now', output: 'see {http://h/?note=%EC%9D%B4|http://h/?note=이} now' },
  { name: 'trailing period stays outside', input: 'go to https://a.b/c.', output: 'go to {https://a.b/c|https://a.b/c}.' },
  { name: 'trailing comma and question mark stay outside', input: 'https://a.b/c, https://a.b/d?', output: '{https://a.b/c|https://a.b/c}, {https://a.b/d|https://a.b/d}?' },
  { name: 'balanced parentheses stay inside, the closing one outside', input: '(https://en.wikipedia.org/wiki/A_(b))', output: '({https://en.wikipedia.org/wiki/A_(b)|https://en.wikipedia.org/wiki/A_(b)})' },
  { name: 'markdown href keeps balanced parentheses', input: '[w](https://en.wikipedia.org/wiki/A_(b))', output: '{https://en.wikipedia.org/wiki/A_(b)|w}' },
  { name: 'javascript scheme is left as text', input: '[x](javascript:alert(1))', output: '[x](javascript:alert(1))' },
  { name: 'data scheme is left as text', input: '[x](data:text/html,hi)', output: '[x](data:text/html,hi)' },
  { name: 'malformed percent encoding shows the raw url', input: 'http://h/%E0%A4%A', output: '{http://h/%E0%A4%A|http://h/%E0%A4%A}' },
  { name: 'stars and underscores stay in the url', input: 'http://h/a_b*c*d', output: '{http://h/a_b*c*d|http://h/a_b*c*d}' },
  { name: 'uppercase scheme', input: 'HTTPS://A.B/x', output: '{HTTPS://A.B/x|HTTPS://A.B/x}' },
  { name: 'scheme alone is not a link', input: 'https://.', output: 'https://.' },
  { name: 'quote ends a bare url', input: 'a "http://h/x" b', output: 'a "{http://h/x|http://h/x}" b' },
  { name: 'text without urls is unchanged', input: '그냥 [괄호](없음) 글', output: '그냥 [괄호](없음) 글' },
];
```

- [ ] **Step 2: 실패하는 시험 작성**

`test/links.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, readableUrl } from '../src/shared/links.js';
import { LINK_CASES, LINK_CASE_KEEP } from './helpers/link-cases.js';

for (const c of LINK_CASES) {
  test(`linkify: ${c.name}`, () => {
    assert.equal(linkify(c.input, LINK_CASE_KEEP), c.output);
  });
}

test('readableUrl decodes percent-encoded UTF-8 and keeps reserved escapes', () => {
  assert.equal(readableUrl('http://h/?p=%EC%9D%B4%2F'), 'http://h/?p=이%2F');
});

test('readableUrl returns the input when decoding fails', () => {
  assert.equal(readableUrl('http://h/%E0'), 'http://h/%E0');
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/links.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/links.js'`

- [ ] **Step 4: 구현**

`src/shared/links.ts`:

```ts
const LINK = /\[([^\]\n]+)\]\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)|(https?:\/\/[^\s<>"'`]+)/gi;
const WEB = /^https?:\/\//i;
const WEB_WITH_HOST = /^https?:\/\/./i;
const TRAILING = `.,;:!?'"`;

export function readableUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

function splitTrailing(url: string): [string, string] {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    const body = url.slice(0, end);
    if (TRAILING.includes(c) || (c === ')' && count(body, ')') > count(body, '(')) || (c === ']' && count(body, ']') > count(body, '['))) {
      end--;
      continue;
    }
    break;
  }
  return [url.slice(0, end), url.slice(end)];
}

// The dashboard keeps a JS copy of these rules (src/dashboard/index.html, linkify); test/helpers/link-cases.ts runs both.
export function linkify(text: string, keep: (href: string, label: string) => string): string {
  return text.replace(LINK, (match: string, title: string | undefined, href: string | undefined, bare: string | undefined) => {
    if (bare === undefined) return WEB.test(href!) ? keep(href!, title!) : match;
    const [url, tail] = splitTrailing(bare);
    return WEB_WITH_HOST.test(url) ? keep(url, readableUrl(url)) + tail : match;
  });
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/links.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/shared/links.ts test/helpers/link-cases.ts test/links.test.ts
git commit -m "feat(links): shared linkify rules for markdown links and bare urls"
```

---

### Task 2: 텔레그램 `mdToHtml`에 링크 적용

**Files:**
- Modify: `src/hub/telegram.ts` (import 줄, `mdToHtml`의 코드 추출 직후 — 지금 `text = text.replace(/\`([^\`\n]+)\`/g, …)` 블록 다음, `let html = this.escHtml(text);` 앞)
- Test: `test/telegram-links.test.ts`

**Interfaces:**
- Consumes: `linkify` (Task 1)

- [ ] **Step 1: 실패하는 시험 작성**

`test/telegram-links.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-links.test.ts`
Expected: FAIL — 링크 시험 4개가 원문 그대로 나온다(마지막 두 시험과 코드 시험은 통과)

- [ ] **Step 3: 구현**

`src/hub/telegram.ts` 위쪽 import에 추가:

```ts
import { linkify } from '../shared/links.js';
```

`mdToHtml`에서 인라인 코드 추출 블록 바로 다음에 추가:

```ts
    text = linkify(text, (href, label) => {
      const i = tokens.push(`<a href="${this.escHtml(href).replace(/"/g, '&quot;')}">${this.escHtml(label)}</a>`) - 1;
      return placeholder(i);
    });
```

`// Restore code tokens` 주석은 `// Restore code and link tokens`로 바꾼다.

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-links.test.ts test/telegram-limits.test.ts test/telegram-delivery.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/hub/telegram.ts test/telegram-links.test.ts
git commit -m "feat(telegram): render markdown links and bare urls as anchors"
```

---

### Task 3: 대시보드 `renderMarkdown`에 링크 적용

**Files:**
- Modify: `src/dashboard/index.html` — `function renderMarkdown(text) {`(지금 2014행) 바로 앞에 `readableUrl`·`splitTrailing`·`linkify` 추가, `renderMarkdown` 교체, `.message-body` 스타일 묶음(지금 594~616행 근처)에 링크 스타일 한 줄
- Test: `test/dashboard-links.test.ts`

**Interfaces:**
- Consumes: `LINK_CASES`, `LINK_CASE_KEEP` (Task 1)

- [ ] **Step 1: 실패하는 시험 작성**

`test/dashboard-links.test.ts` (회귀 기대값은 지금 `renderMarkdown`을 그대로 돌려 뽑은 값이다):

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LINK_CASES, LINK_CASE_KEEP } from './helpers/link-cases.js';

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
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-links.test.ts`
Expected: FAIL — `anchors not found`

- [ ] **Step 3: 구현 — 링크 함수 추가와 `renderMarkdown` 교체**

`src/dashboard/index.html`의 지금 `function renderMarkdown(text) { … }` 전체(2014~2037행)를 다음으로 바꾼다:

```js
  function readableUrl(url) {
    try { return decodeURI(url); } catch { return url; }
  }

  function splitTrailing(url) {
    const count = (s, ch) => s.split(ch).length - 1;
    let end = url.length;
    while (end > 0) {
      const c = url[end - 1];
      const body = url.slice(0, end);
      if (`.,;:!?'"`.includes(c) || (c === ')' && count(body, ')') > count(body, '(')) || (c === ']' && count(body, ']') > count(body, '['))) { end--; continue; }
      break;
    }
    return [url.slice(0, end), url.slice(end)];
  }

  // Copy of src/shared/links.ts (used for Telegram); test/dashboard-links.test.ts runs both on one case list.
  function linkify(text, keep) {
    return text.replace(/\[([^\]\n]+)\]\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)|(https?:\/\/[^\s<>"'`]+)/gi, (match, title, href, bare) => {
      if (bare === undefined) return /^https?:\/\//i.test(href) ? keep(href, title) : match;
      const [url, tail] = splitTrailing(bare);
      return /^https?:\/\/./i.test(url) ? keep(url, readableUrl(url)) + tail : match;
    });
  }

  function renderMarkdown(text) {
    const kept = [];
    const keep = (part) => `\uE000${kept.push(part) - 1}\uE001`;
    let src = String(text);
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, body) => keep(`<pre><code>${esc(body)}</code></pre>`));
    src = src.replace(/`([^`]+)`/g, (_m, body) => keep(`<code>${esc(body)}</code>`));
    src = linkify(src, (href, label) => keep(`<a href="${esc(href).replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`));
    let html = esc(src);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^(\|.+\|)\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/gm, (_, header, body) => {
      const ths = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
      const rows = body.trim().split('\n').map(row => {
        const tds = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
    });
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    // Restore before the newline pass: the <br> cleanup below needs to see the <pre> tags.
    html = html.replace(/\uE000(\d+)\uE001/g, (m, n) => kept[Number(n)] ?? m);
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/<br>\s*(<\/?(?:pre|h[2-4]|ul|li|table|thead|tbody|tr))/g, '$1');
    html = html.replace(/(<\/(?:pre|h[2-4]|ul|table)>)\s*<br>/g, '$1');
    return html;
  }
```

- [ ] **Step 4: 구현 — 링크 스타일**

`.message-body table { … }` 줄 바로 앞에 추가:

```css
  .message-body a { color: var(--blue); text-decoration: underline; word-break: break-all; }
```

- [ ] **Step 5: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-links.test.ts test/dashboard-questions.test.ts test/dashboard-permissions.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/dashboard/index.html test/dashboard-links.test.ts
git commit -m "feat(dashboard): render markdown links and bare urls as anchors"
```

---

### Task 4: 채널 서버의 토큰 계산 `readContextTokens`

**Files:**
- Modify: `src/channel/peer-name.ts` (세션 기록 읽기를 함수로 빼서 함께 씀)
- Create: `src/channel/context-tokens.ts`
- Test: `test/context-tokens.test.ts`

**Interfaces:**
- Produces (`peer-name.ts`): `claudeConfigDir(env: NodeJS.ProcessEnv): string`, `readSessionRecords(configDir: string): unknown[]`
- Produces (`context-tokens.ts`): `contextSize(entries: Array<Record<string, unknown>>): number | null`, `findSession(records: unknown[], env: { messagingSocket?: string; sessionId?: string }): { sessionId: string; cwd?: string } | undefined`, `transcriptPath(configDir: string, cwd: string, sessionId: string): string | undefined`, `readContextTokens(env?: NodeJS.ProcessEnv, cwd?: string): number | null`

- [ ] **Step 1: 실패하는 시험 작성**

`test/context-tokens.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextSize, findSession, readContextTokens, transcriptPath } from '../src/channel/context-tokens.js';

const SOCK = '\\\\.\\pipe\\LOCAL\\cc-msg-aaa';
const reply = (input: number, read: number, write: number, extra: object = {}) =>
  ({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 9 } }, ...extra });

function configDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-tokens-'));
}

function writeRecord(dir: string, rec: object, file = '1.json'): void {
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', file), JSON.stringify(rec));
}

function writeTranscript(dir: string, project: string, sessionId: string, lines: unknown[]): string {
  const folder = path.join(dir, 'projects', project);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

test('contextSize sums the last main reply', () => {
  assert.equal(contextSize([reply(1, 2, 3), reply(2, 100, 10)]), 112);
});

test('contextSize skips sidechain and synthetic replies', () => {
  const synthetic = { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0 } } };
  assert.equal(contextSize([reply(1, 10, 0), reply(5, 500, 0, { isSidechain: true }), synthetic]), 11);
});

test('contextSize is 0 after a compact boundary and null without replies', () => {
  assert.equal(contextSize([reply(1, 10, 0), { type: 'system', subtype: 'compact_boundary' }]), 0);
  assert.equal(contextSize([{ type: 'user', message: { content: 'hi' } }]), null);
});

test('findSession prefers the messaging socket over the stale session id', () => {
  const records = [
    { sessionId: 'sid-old', cwd: 'C:\\w\\other' },
    { sessionId: 'sid-new', cwd: 'C:\\w\\app', messagingSocketPath: SOCK },
  ];
  assert.deepEqual(findSession(records, { messagingSocket: SOCK, sessionId: 'sid-old' }), { sessionId: 'sid-new', cwd: 'C:\\w\\app' });
});

test('findSession falls back to the session id and ignores malformed records', () => {
  assert.deepEqual(findSession([null, { sessionId: 7 }, { sessionId: 'sid-a' }], { sessionId: 'sid-a' }), { sessionId: 'sid-a', cwd: undefined });
  assert.equal(findSession([{ sessionId: 'x' }], { messagingSocket: 'nope' }), undefined);
});

test('transcriptPath uses the sanitized cwd, then scans the other project folders', () => {
  const dir = configDir();
  const direct = writeTranscript(dir, 'C--w-app', 'sid-1', [reply(1, 1, 1)]);
  assert.equal(transcriptPath(dir, 'C:\\w\\app', 'sid-1'), direct);
  const moved = writeTranscript(dir, 'C--somewhere-else', 'sid-2', [reply(1, 1, 1)]);
  assert.equal(transcriptPath(dir, 'C:\\w\\app', 'sid-2'), moved);
  assert.equal(transcriptPath(dir, 'C:\\w\\app', 'sid-3'), undefined);
});

test('readContextTokens follows the registry to the current session after /clear', () => {
  const dir = configDir();
  writeRecord(dir, { sessionId: 'sid-new', cwd: 'C:\\w\\app', messagingSocketPath: SOCK });
  writeTranscript(dir, 'C--w-app', 'sid-old', [reply(1, 999, 0)]);
  writeTranscript(dir, 'C--w-app', 'sid-new', [reply(2, 40, 8)]);
  const env = { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_CODE_SESSION_ID: 'sid-old' };
  assert.equal(readContextTokens(env, 'C:\\ignored'), 50);
});

test('readContextTokens without a registry uses the env session id and the given cwd', () => {
  const dir = configDir();
  writeTranscript(dir, 'C--w-app', 'sid-a', ['{broken', reply(3, 30, 0)]);
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sid-a' }, 'C:\\w\\app'), 33);
});

test('readContextTokens reads only the tail of a large transcript', () => {
  const dir = configDir();
  const filler = { type: 'user', message: { content: 'x'.repeat(1000) } };
  const lines: unknown[] = [reply(1, 1, 1)];
  for (let i = 0; i < 1500; i++) lines.push(filler);
  lines.push(reply(4, 400, 0));
  const file = writeTranscript(dir, 'C--w-app', 'sid-big', lines);
  assert.ok(fs.statSync(file).size > 1024 * 1024);
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sid-big' }, 'C:\\w\\app'), 404);
});

test('readContextTokens returns null when nothing can be read', () => {
  const dir = configDir();
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'none' }, 'C:\\w\\app'), null);
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir }, 'C:\\w\\app'), null);
});

test('readContextTokens refuses a session id carrying path characters', () => {
  const dir = configDir();
  writeTranscript(dir, 'C--w-app', 'secret', [reply(1, 1, 1)]);
  writeRecord(dir, { sessionId: '../C--w-app/secret', cwd: 'C:\\w\\app', messagingSocketPath: SOCK });
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: SOCK }, 'C:\\w\\app'), null);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/context-tokens.test.ts`
Expected: FAIL — `Cannot find module '../src/channel/context-tokens.js'`

- [ ] **Step 3: 구현 — `peer-name.ts`에서 기록 읽기 분리**

`src/channel/peer-name.ts`의 `readPeerName`을 다음으로 바꾸고 두 함수를 더한다(`findPeerName`은 그대로):

```ts
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function readSessionRecords(configDir: string): unknown[] {
  const dir = path.join(configDir, 'sessions');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const f of files) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {}
  }
  return records;
}

// <configDir>/sessions/<pid>.json is Claude Code's undocumented peer registry
// (the source of ListAgents/SendMessage names, verified on 2.1.283). Its format
// may change between releases, so every failure must degrade to "no name".
export function readPeerName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lookup: PeerLookupEnv = {
    messagingSocket: env.CLAUDE_CODE_MESSAGING_SOCKET,
    sessionId: env.CLAUDE_CODE_SESSION_ID,
  };
  if (!lookup.messagingSocket && !lookup.sessionId) return undefined;
  return findPeerName(readSessionRecords(claudeConfigDir(env)), lookup);
}
```

- [ ] **Step 4: 구현 — `context-tokens.ts`**

`src/channel/context-tokens.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigDir, readSessionRecords } from './peer-name.js';

// Reads Claude Code's undocumented transcript, <configDir>/projects/<cwd>/<sessionId>.jsonl
// (verified on 2.1.296). A format change must degrade to null, never throw.

const TAIL_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

type Entry = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function contextSize(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return 0;
    if (entry.type !== 'assistant' || entry.isSidechain === true || !isRecord(entry.message)) continue;
    const { model, usage } = entry.message;
    if (model === '<synthetic>' || !isRecord(usage)) continue;
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    return count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens');
  }
  return null;
}

export function findSession(
  records: unknown[],
  env: { messagingSocket?: string; sessionId?: string },
): { sessionId: string; cwd?: string } | undefined {
  const valid = records.filter((r): r is Record<string, unknown> => isRecord(r) && typeof r.sessionId === 'string');
  const rec =
    (env.messagingSocket ? valid.find((r) => r.messagingSocketPath === env.messagingSocket) : undefined) ??
    (env.sessionId ? valid.find((r) => r.sessionId === env.sessionId) : undefined);
  if (!rec) return undefined;
  return { sessionId: rec.sessionId as string, cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined };
}

export function transcriptPath(configDir: string, cwd: string, sessionId: string): string | undefined {
  const projects = path.join(configDir, 'projects');
  const file = `${sessionId}.jsonl`;
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), file);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(projects)) {
      const candidate = path.join(projects, dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return undefined;
}

function readTail(file: string): Entry[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (length < size) text = text.slice(text.indexOf('\n') + 1);
    const entries: Entry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value)) entries.push(value);
      } catch {}
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

export function readContextTokens(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number | null {
  try {
    const configDir = claudeConfigDir(env);
    const lookup = { messagingSocket: env.CLAUDE_CODE_MESSAGING_SOCKET, sessionId: env.CLAUDE_CODE_SESSION_ID };
    const found = findSession(readSessionRecords(configDir), lookup);
    const sessionId = found?.sessionId ?? lookup.sessionId;
    if (!sessionId || !SAFE_ID.test(sessionId)) return null;
    const file = transcriptPath(configDir, found?.cwd ?? cwd, sessionId);
    return file ? contextSize(readTail(file)) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/context-tokens.test.ts test/peer-name.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/channel/peer-name.ts src/channel/context-tokens.ts test/context-tokens.test.ts
git commit -m "feat(channel): read the session's context token count from its transcript"
```

---

### Task 5: Hub의 `context_tokens` 처리

**Files:**
- Modify: `src/shared/types.ts:24-38` (`SessionInfo`), `src/shared/types.ts:66-97` (`ChannelMessage`)
- Modify: `src/shared/constants.ts:19` (`HUB_FEATURES`)
- Modify: `src/hub/session-manager.ts` (`setPeerName` 다음에 `setContextTokens`)
- Modify: `src/hub/server.ts` (`case 'peer_name'` 다음에 `case 'context_tokens'`)
- Modify: `test/hub-questions.test.ts:302,307` (`hub_info` 기대값)
- Test: `test/session-manager.test.ts`, `test/hub-context-tokens.test.ts`

**Interfaces:**
- Produces: `SessionInfo.contextTokens?: number`; `ChannelMessage` 항목 `{ type: 'context_tokens'; sessionId: string; tokens: number | null }`; `HUB_FEATURES = ['questions', 'context_tokens']`; `SessionManager.setContextTokens(sessionId: string, tokens: unknown): SessionInfo | undefined`

- [ ] **Step 1: 실패하는 시험 작성**

`test/session-manager.test.ts` 끝에 추가:

```ts
test('setContextTokens keeps non-negative integers and clears anything else', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a'));
  assert.equal(sm.setContextTokens('a', 132854)?.contextTokens, 132854);
  assert.equal(sm.setContextTokens('a', 0)?.contextTokens, 0);
  for (const bad of [null, -1, 1.5, '12', Number.NaN, Number.POSITIVE_INFINITY]) {
    sm.setContextTokens('a', 5);
    assert.equal(sm.setContextTokens('a', bad)?.contextTokens, undefined, String(bad));
  }
  assert.equal(sm.setContextTokens('ghost', 1), undefined);
});
```

`test/hub-context-tokens.test.ts`:

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7997;
const settle = () => new Promise((r) => setTimeout(r, 150));

function connect(path: string, inbox: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?token=t`);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('hub stores context_tokens, tells dashboards, and ignores other sockets', async () => {
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: 't' } } as any);
  await hub.start();
  try {
    const aIn: any[] = [];
    const a = await connect('/ws/channel', aIn);
    a.send(JSON.stringify({ type: 'register', session: { id: 'a', name: 'a', status: 'idle', connectedAt: 0, lastActivity: 0, cwd: '/w/a', channelEnabled: true } }));
    const b = await connect('/ws/channel', []);
    b.send(JSON.stringify({ type: 'register', session: { id: 'b', name: 'b', status: 'idle', connectedAt: 0, lastActivity: 0, cwd: '/w/b', channelEnabled: true } }));
    const dash: any[] = [];
    const d = await connect('/ws/dashboard', dash);
    await settle();

    assert.ok(aIn.some((m) => m.type === 'hub_info' && m.features.includes('context_tokens')));

    a.send(JSON.stringify({ type: 'context_tokens', sessionId: 'a', tokens: 132854 }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.contextTokens, 132854);
    const update = dash.filter((m) => m.type === 'session_updated').pop();
    assert.equal(update?.session.id, 'a');
    assert.equal(update?.session.contextTokens, 132854);

    b.send(JSON.stringify({ type: 'context_tokens', sessionId: 'a', tokens: 1 }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.contextTokens, 132854);

    a.send(JSON.stringify({ type: 'context_tokens', sessionId: 'a', tokens: null }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.contextTokens, undefined);

    a.close();
    b.close();
    d.close();
  } finally {
    await hub.stop();
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/session-manager.test.ts test/hub-context-tokens.test.ts`
Expected: FAIL — `sm.setContextTokens is not a function`, `hub_info`에 `context_tokens` 없음

- [ ] **Step 3: 구현**

`src/shared/types.ts` `SessionInfo`의 `closable?: boolean;` 다음 줄:

```ts
  contextTokens?: number;
```

`ChannelMessage`의 `peer_name` 줄 다음:

```ts
  | { type: 'context_tokens'; sessionId: string; tokens: number | null }
```

`src/shared/constants.ts:19`:

```ts
export const HUB_FEATURES: readonly string[] = ['questions', 'context_tokens'];
```

`src/hub/session-manager.ts`의 `setPeerName` 메서드 다음:

```ts
  setContextTokens(sessionId: string, tokens: unknown): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.contextTokens = Number.isSafeInteger(tokens) && (tokens as number) >= 0 ? (tokens as number) : undefined;
    }
    return session;
  }
```

`src/hub/server.ts`의 `case 'peer_name': { … }` 블록 다음:

```ts
      case 'context_tokens': {
        const updated = this.sessions.setContextTokens(msg.sessionId, msg.tokens);
        if (updated) this.broadcastToDashboards({ type: 'session_updated', session: updated });
        break;
      }
```

`test/hub-questions.test.ts` 302행과 307행의 `features: ['questions']`를 `features: ['questions', 'context_tokens']`로 바꾼다.

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/session-manager.test.ts test/hub-context-tokens.test.ts test/hub-questions.test.ts test/hub-peer-name.test.ts test/hub-ownership.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/shared/types.ts src/shared/constants.ts src/hub/session-manager.ts src/hub/server.ts test/session-manager.test.ts test/hub-context-tokens.test.ts test/hub-questions.test.ts
git commit -m "feat(hub): keep each session's context token count and tell dashboards"
```

---

### Task 6: 채널 서버가 토큰 수를 보내기

**Files:**
- Create: `src/channel/context-reporter.ts`
- Modify: `src/channel/server.ts` (import, `main()`의 피어 이름 타이머, `hubClient.onMessage` 처리기 맨 앞)
- Test: `test/context-reporter.test.ts`

**Interfaces:**
- Consumes: `readContextTokens` (Task 4), `ChannelMessage`의 `context_tokens` (Task 5), `HubClient.supports(feature)`·`send(msg)`
- Produces: `class ContextTokenReporter { constructor(hub: { supports(feature: string): boolean; send(msg: ChannelMessage): unknown }, sessionId: string, read: () => number | null); refresh(): void; reset(): void }`

- [ ] **Step 1: 실패하는 시험 작성**

`test/context-reporter.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextTokenReporter } from '../src/channel/context-reporter.js';

function fakeHub(features: string[]) {
  const sent: any[] = [];
  return { sent, hub: { supports: (f: string) => features.includes(f), send: (m: any) => { sent.push(m); return 'sent'; } } };
}

test('sends only when the value changes', () => {
  const { sent, hub } = fakeHub(['context_tokens']);
  let value: number | null = 100;
  const r = new ContextTokenReporter(hub, 's1', () => value);
  r.refresh();
  r.refresh();
  value = 250;
  r.refresh();
  value = null;
  r.refresh();
  assert.deepEqual(sent, [
    { type: 'context_tokens', sessionId: 's1', tokens: 100 },
    { type: 'context_tokens', sessionId: 's1', tokens: 250 },
    { type: 'context_tokens', sessionId: 's1', tokens: null },
  ]);
});

test('sends nothing to a hub without the feature and does not read the transcript', () => {
  const { sent, hub } = fakeHub(['questions']);
  let reads = 0;
  new ContextTokenReporter(hub, 's1', () => { reads++; return 5; }).refresh();
  assert.equal(sent.length, 0);
  assert.equal(reads, 0);
});

test('reset sends the same value again after a hub reconnect', () => {
  const { sent, hub } = fakeHub(['context_tokens']);
  const r = new ContextTokenReporter(hub, 's1', () => 42);
  r.refresh();
  r.reset();
  r.refresh();
  assert.equal(sent.length, 2);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/context-reporter.test.ts`
Expected: FAIL — `Cannot find module '../src/channel/context-reporter.js'`

- [ ] **Step 3: 구현 — 보고기**

`src/channel/context-reporter.ts`:

```ts
import type { ChannelMessage } from '../shared/types.js';

export const CONTEXT_TOKENS_FEATURE = 'context_tokens';

interface ReporterHub {
  supports(feature: string): boolean;
  send(msg: ChannelMessage): unknown;
}

export class ContextTokenReporter {
  private last: number | null | undefined;

  constructor(
    private readonly hub: ReporterHub,
    private readonly sessionId: string,
    private readonly read: () => number | null,
  ) {}

  refresh(): void {
    if (!this.hub.supports(CONTEXT_TOKENS_FEATURE)) return;
    const tokens = this.read();
    if (tokens === this.last) return;
    this.last = tokens;
    this.hub.send({ type: 'context_tokens', sessionId: this.sessionId, tokens });
  }

  // A new hub connection starts with no count for this session.
  reset(): void {
    this.last = undefined;
  }
}
```

- [ ] **Step 4: 구현 — 채널 서버 연결**

`src/channel/server.ts` import 줄(`import { readPeerName } from './peer-name.js';` 다음):

```ts
import { readContextTokens } from './context-tokens.js';
import { ContextTokenReporter } from './context-reporter.js';
```

`main()`의 피어 이름 타이머 두 줄(`setTimeout(refreshPeerName, 2_000).unref();`, `setInterval(refreshPeerName, 30_000).unref();`)을 다음으로 바꾼다:

```ts
  const contextTokens = new ContextTokenReporter(hubClient, sessionId, () => readContextTokens());
  const refreshSessionFacts = () => {
    refreshPeerName();
    contextTokens.refresh();
  };
  setTimeout(refreshSessionFacts, 2_000).unref();
  setInterval(refreshSessionFacts, 30_000).unref();
```

`hubClient.onMessage(async (msg) => {` 처리기의 첫 줄에 추가:

```ts
    if (msg.type === 'hub_info') {
      contextTokens.reset();
      contextTokens.refresh();
      return;
    }
```

(`hub_info`는 `HubClient`가 기능 목록을 먼저 배운 뒤 처리기에 넘기므로(`src/channel/hub-client.ts:53-56`) 여기서 `supports`가 맞게 답한다.)

- [ ] **Step 5: 통과 확인과 타입 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/context-reporter.test.ts test/channel-ask.test.ts && npx tsc --noEmit -p .`
Expected: PASS, 타입 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/channel/context-reporter.ts src/channel/server.ts test/context-reporter.test.ts
git commit -m "feat(channel): report the context token count to hubs that support it"
```

---

### Task 7: 대시보드 세션 카드에 토큰 수 표시

**Files:**
- Modify: `src/dashboard/index.html` — `function renderSessions() {` 바로 앞에 `formatTokens`, `renderSessions`의 `session-cwd` 두 줄, `.session-cwd` 스타일 근처에 `.session-tokens`
- Test: `test/dashboard-context-tokens.test.ts`

**Interfaces:**
- Consumes: `SessionInfo.contextTokens` (Task 5)

- [ ] **Step 1: 실패하는 시험 작성**

`test/dashboard-context-tokens.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function load(sessions: Record<string, any>) {
  const start = html.indexOf('  function formatTokens(n) {');
  const end = html.indexOf('  function bindSessionCards(el) {');
  assert.ok(start > 0 && end > start, 'anchors not found');
  const list = { innerHTML: '' };
  const ctx: Record<string, any> = {
    $: (sel: string) => (sel === '#sessionsList' ? list : null),
    state: { sessions, selectedSession: null, unread: {}, closeArmed: null },
    getOrderedSessionIds: () => Object.keys(sessions),
    sessionDisplayName: (s: any) => s.name,
    closeStep: () => 'arm',
    bindSessionCards: () => {},
    updateImageUI: () => {},
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, list };
}

const session = (extra: object) => ({ id: 's1', name: 'app', status: 'idle', connectedAt: 0, cwd: 'C:\\w\\app', ...extra });

test('formatTokens shortens counts and hides empty ones', () => {
  const { ctx } = load({});
  const cases: Array<[unknown, string]> = [
    [undefined, ''], [null, ''], [0, ''], [-5, ''], ['12', ''], [Number.NaN, ''],
    [850, '850'], [1000, '1k'], [132854, '133k'], [999_499, '999k'], [999_500, '1.0M'], [1_234_567, '1.2M'],
  ];
  for (const [input, output] of cases) assert.equal(ctx.formatTokens(input), output, String(input));
});

test('a session card shows the count with the exact value on hover', () => {
  const { ctx, list } = load({ s1: session({ contextTokens: 132854 }) });
  ctx.renderSessions();
  assert.match(list.innerHTML, /&middot; <span class="session-tokens" title="Context: 132,854 tokens">133k<\/span>/);
});

test('a card without a count shows no token part', () => {
  const { ctx, list } = load({ s1: session({}), s2: { ...session({ contextTokens: 0 }), id: 's2', cwd: undefined } });
  ctx.renderSessions();
  assert.doesNotMatch(list.innerHTML, /session-tokens/);
});

test('a card without a folder still shows the count', () => {
  const { ctx, list } = load({ s1: session({ cwd: undefined, contextTokens: 2000 }) });
  ctx.renderSessions();
  assert.match(list.innerHTML, /class="session-tokens"[^>]*>2k</);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-context-tokens.test.ts`
Expected: FAIL — `anchors not found`

- [ ] **Step 3: 구현**

`  function renderSessions() {` 바로 앞에 추가:

```js
  function formatTokens(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
    if (n < 1000) return String(Math.round(n));
    if (n < 999_500) return `${Math.round(n / 1000)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

```

`renderSessions` 안, `const connTime = …` 다음 줄에 추가:

```js
      const tokens = formatTokens(s.contextTokens);
      const tokensPart = tokens ? ` &middot; <span class="session-tokens" title="Context: ${s.contextTokens.toLocaleString('en-US')} tokens">${tokens}</span>` : '';
```

`session-cwd` 줄을 다음으로 바꾼다:

```js
          ${cwdDisplay ? `<div class="session-cwd" title="${esc(s.cwd)}">${esc(cwdDisplay)} &middot; ${connTime}${tokensPart}</div>` : `<div class="session-cwd">${connTime}${tokensPart}</div>`}
```

`.session-cwd { … }` 규칙 다음에 추가:

```css
  .session-tokens { color: var(--text); }
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-context-tokens.test.ts test/dashboard-codex.test.ts test/dashboard-mention.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/dashboard/index.html test/dashboard-context-tokens.test.ts
git commit -m "feat(dashboard): show each session's context token count on its card"
```

---

### Task 8: 문서, 전체 시험, 실측

**Files:**
- Modify: `README.md` (`## Dashboard` 절, `## Telegram Bot` 절)
- Memory: `C:\Users\USER\.claude\projects\C--workspace-claude-alarm\memory\project_peer_registry.md`

- [ ] **Step 1: README**

`## Dashboard` 절의 그림 다음에 한 단락:

```markdown
Session cards show each Claude session's context size (for example `· 133k`; hover for the exact count). The channel server reads it from the session's transcript under `~/.claude/projects` every 30 seconds. Links in session messages open in a new tab and show their title, or the decoded address for a bare URL.
```

`## Telegram Bot` 절 끝에 한 줄:

```markdown
Markdown links in session messages arrive as tappable links that show their title.
```

- [ ] **Step 2: 전체 시험과 빌드**

Run: `npm test` 그다음 `npm run build`
Expected: 실패 0, 빌드 성공. 실패가 있으면 출력 그대로 기록하고 고친다

- [ ] **Step 3: 실측 (HOME 격리 Hub + 실제 대화 기록, 읽기만)**

스크래치 폴더에 `live-check.mjs`를 만들어 실행한다. 임시 HOME에 Hub를 7991 포트로 띄우고, 빌드한 채널 서버를 이 세션의 소켓·세션 id·**실제** `CLAUDE_CONFIG_DIR`로 띄워 Hub `/api/sessions`에 `contextTokens`가 오는지 본다. 띄운 PID만 종료한다.

```js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = 'C:/workspace/claude-alarm';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-live-'));
fs.mkdirSync(path.join(home, '.claude-alarm'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({ hub: { host: '127.0.0.1', port: 7991, token: 'live-t' } }));
const env = { ...process.env, HOME: home, USERPROFILE: home };

const hub = spawn(process.execPath, [`${repo}/dist/cli.js`, 'hub', 'start'], { env, stdio: 'ignore', windowsHide: true });
await new Promise((r) => setTimeout(r, 2000));
const channel = spawn(process.execPath, [`${repo}/dist/channel/server.js`], {
  env: { ...env, CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude'), CLAUDE_ALARM_HUB_PORT: '7991', CLAUDE_ALARM_HUB_TOKEN: 'live-t' },
  stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
});
await new Promise((r) => setTimeout(r, 5000));
const res = await fetch('http://127.0.0.1:7991/api/sessions', { headers: { Authorization: 'Bearer live-t' } });
console.log(JSON.stringify(await res.json(), null, 2));
channel.kill();
hub.kill();
console.log('killed', channel.pid, hub.pid);
```

이 세션의 `os.homedir()`가 진짜 홈이어야 한다(스크립트를 띄우는 셸의 HOME). `CLAUDE_CODE_SESSION_ID`·`CLAUDE_CODE_MESSAGING_SOCKET`은 이 세션 셸의 값을 그대로 물려받는다.
Expected: 세션 하나, `contextTokens`가 이 세션 크기(수십만 이하의 양수). 끝난 뒤 `Get-Process -Id <두 PID>`가 없음

- [ ] **Step 4: 실측 — 화면**

같은 방식으로 Hub를 띄워 둔 채 Chrome(claude-in-chrome)으로 `http://127.0.0.1:7991`에 `live-t`로 들어가 세션 카드의 `· NNNk`와 마우스를 올렸을 때의 정확한 값을 확인한다. 링크는 채널 서버 stdin으로 MCP `initialize` → `notifications/initialized` → `tools/call reply { content: "[문서](http://192.168.0.8:37290/?note=%EC%9D%B4) 그리고 https://example.com/a_(b)." }`를 보내 대화 영역에 제목 링크와 그냥 주소 링크가 보이는지 본다. 스크린샷을 남기고 띄운 PID만 종료한다

- [ ] **Step 5: 메모리와 커밋**

`project_peer_registry.md`에 한 줄을 더한다: 채널 서버가 `~/.claude/projects/<cwd>/<sessionId>.jsonl`(비공개 형식)의 마지막 `usage`로 컨텍스트 토큰을 계산한다(`src/channel/context-tokens.ts`, 2.1.296 확인), 업데이트 때 함께 점검.

```bash
git add README.md
git commit -m "docs: context token count on session cards and rendered links"
```

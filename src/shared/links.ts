// Renderers park code as placeholders (\u0000 in Telegram, \uE000/\uE001 in the dashboard) before calling
// linkify, so those characters must end an address. The title length cap keeps a run of unmatched '['
// linear instead of rescanning the rest of the line for each one.
const LINK = /\[([^\]\n]{1,300})\]\(([^\s()\u0000\uE000\uE001]*(?:\([^\s()\u0000\uE000\uE001]*\)[^\s()\u0000\uE000\uE001]*)*)\)|(https?:\/\/[^\s<>"'`\u0000\uE000\uE001]+)/gi;
const WEB = /^https?:\/\//i;
const WEB_WITH_HOST = /^https?:\/\/./i;
const TRAILING = `.,;:!?'"*_~`;

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
  let opens = count(url, '(');
  let closes = count(url, ')');
  let openBrackets = count(url, '[');
  let closeBrackets = count(url, ']');
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if (TRAILING.includes(c)) end--;
    else if (c === ')' && closes > opens) { closes--; end--; }
    else if (c === ']' && closeBrackets > openBrackets) { closeBrackets--; end--; }
    else break;
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

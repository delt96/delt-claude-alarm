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

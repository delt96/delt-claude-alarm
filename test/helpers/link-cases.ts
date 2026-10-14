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

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

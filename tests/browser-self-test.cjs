'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const elements = new Map();

for (const match of html.matchAll(/<input\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const attrs = match[1];
  const value = attrs.match(/\bvalue="([^"]*)"/)?.[1] || '';
  elements.set(match[2], {
    value,
    checked: /\bchecked\b/.test(attrs),
    textContent: '',
    disabled: false
  });
}
for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const options = [...match[2].matchAll(/<option\b([^>]*)>/g)]
    .map(option => [option[1], option[1].match(/\bvalue="([^"]*)"/)?.[1] || '']);
  const selected = options.find(option => /\bselected\b/.test(option[0])) || options[0];
  elements.set(match[1], { value: selected?.[1] || '', textContent: '', disabled: false });
}
elements.set('tests', { value: '', textContent: '', disabled: false });

const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', checked: false, disabled: false });
    return elements.get(id);
  }
};

const moduleSource = ['core.js', 'config.js', 'memory.js', 'colibri.js', 'afm.js', 'playback.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n');
const selfTestSource = fs.readFileSync(path.join(root, 'tests-init.js'), 'utf8')
  .split('function syncMode')[0];
const sandbox = {
  console,
  document,
  performance: { now: () => 0 },
  setTimeout: () => 0,
  clearTimeout: () => {}
};
vm.createContext(sandbox);
vm.runInContext(`${moduleSource}\n${selfTestSource}`, sandbox, { filename: 'browser-self-test-bundle.js' });

test('browser Self-test reports every scenario passing', () => {
  vm.runInContext('tests()', sandbox);
  const output = elements.get('tests').textContent;
  assert.equal(output.includes('FAIL'), false, output);
  assert.equal(output.includes('ERROR'), false, output);
  assert.match(output, /20\/20 passed$/);
});

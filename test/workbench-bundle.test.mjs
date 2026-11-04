import test from 'node:test';
import assert from 'node:assert/strict';
import {bundledWorkbench} from '../src/http.mjs';

test('bundled workbench inlines the dark palette and keeps the host shim', async () => {
  const html = await bundledWorkbench();
  assert.match(html, /--legacy-paint-0:#19171000/);
  assert.match(html, /html\[data-host-theme="dark"\]/);
  assert.match(html, /__FamilyHostFetch/);
  assert.doesNotMatch(html, /<link[^>]+theme-dark\.css/);
});

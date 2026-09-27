'use strict';
// Loads one or more of the app's plain <script>-tag JS files (js/*.js - no ES modules,
// no bundler, see AGENT.md's "Script Load Order") into a single Node vm sandbox, the same
// way index.html loads them into one shared global scope in the browser. Returns the
// sandbox object so a test can pull out whichever top-level functions it needs.
//
// document/Store/window are stubbed as harmless empty-ish objects: none of the PURE
// computational functions these tests target (computeDynSMA, checkCoOccurrence, etc.)
// touch them, and function BODIES aren't executed at load time regardless - only actual
// top-level statements are, and none of the loaded files have any (verified: no top-level
// `document.`/`Store.`/`window.`/`*.addEventListener` outside a function body).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.dirname(__dirname);

function loadScripts(relPaths) {
  const sandbox = {
    console,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: {},
    Store: {},
  };
  sandbox.window = sandbox; // scripts may reference either name for the global scope
  vm.createContext(sandbox);
  for (const rel of relPaths) {
    const file = path.join(REPO_ROOT, rel);
    const src = fs.readFileSync(file, 'utf8');
    vm.runInContext(src, sandbox, { filename: file });
  }
  return sandbox;
}

module.exports = { loadScripts };

import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// Injected at the very top of main.js — runs before any require() call.
//
// Problem: Electron's renderer process require() resolves modules starting from
// the Electron app directory, NOT the plugin folder. So require('pdf-parse')
// fails even though we deployed it to .obsidian/plugins/pageindex-rag/node_modules/.
//
// Fix: hook Module._resolveFilename so that when a module isn't found by the
// default resolver, we retry with an absolute path into the plugin's node_modules.
// __filename is the plugin's main.js path (set by Node.js when Obsidian loads it).
const PLUGIN_REQUIRE_BANNER = `
(function () {
  try {
    var _M = require("module");
    var _p = require("path");
    var _dir = typeof __filename !== "undefined" ? _p.dirname(__filename) : null;
    if (!_dir) return;
    var _nm = _p.join(_dir, "node_modules");
    var _targets = { "pdf-parse": true, "js-tiktoken": true };
    var _orig = _M._resolveFilename;
    _M._resolveFilename = function (id, parent, main, opts) {
      try { return _orig.call(this, id, parent, main, opts); }
      catch (e) {
        if (_targets[id]) {
          try { return _orig.call(this, _p.join(_nm, id), parent, main, opts); }
          catch (e2) {}
        }
        throw e;
      }
    };
  } catch (e) {}
})();
`.trim();

const context = await esbuild.context({
  banner: { js: PLUGIN_REQUIRE_BANNER },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    // Kept external so they load from the plugin's node_modules at runtime.
    // The banner above ensures Electron's renderer can find them there.
    "pdf-parse",
    "js-tiktoken",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  platform: "node",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}

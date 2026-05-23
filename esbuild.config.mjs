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
// Banner injected at the top of main.js.
//
// Primary fix: the plugin's onload() calls patchModuleResolver() with the
// correct path from getBasePath(). This banner is a belt-and-suspenders
// early-boot guard for any require that fires before onload() runs.
//
// Electron's renderer sets __filename to 'electron/js2c/renderer_init' so we
// prefer module.filename (the loaded file's own path) which IS set correctly.
const PLUGIN_REQUIRE_BANNER = `
(function () {
  try {
    var _M = require("module");
    var _p = require("path");
    var _dir = null;
    // Prefer module.filename — set by Node.js module loader to this file's path.
    if (typeof module !== "undefined" && module.filename &&
        module.filename.indexOf("renderer_init") === -1 &&
        module.filename.indexOf("plugins") !== -1) {
      _dir = _p.dirname(module.filename);
    }
    // Fallback: __filename (may be wrong in some Electron builds)
    if (!_dir && typeof __filename !== "undefined" &&
        __filename.indexOf("renderer_init") === -1) {
      _dir = _p.dirname(__filename);
    }
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

"use strict";
/**
 * Shared require hook for the plain-JS child-process workers in this folder
 * (aheadOfUtcChild.js, distributeWorkoutsTzChild.js). Those workers exist
 * because a mid-process `process.env.TZ` change is ignored inside a Jest
 * worker on this repo's Windows setup, so each test spawns a fresh `node`
 * with TZ set at launch. See aheadOfUtcChild.js for why the child is plain
 * JavaScript rather than a spawned Jest/ts-jest process or a built `dist/`.
 *
 * Requiring this module registers a minimal, single-file transpile-on-require
 * hook (via the `typescript` package, already a devDependency) and a small
 * path-alias resolver mirroring packages/core/tsconfig.json's `@src/core`
 * alias. It exports CORE_SRC, the absolute path to packages/core/src.
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const ts = require("typescript");

const CORE_SRC = path.join(__dirname, "..", "..", "src");

// Resolve the `@src/core` / `@src/core/*` path alias packages/core/tsconfig.json
// declares -- the same alias the source files use for their real imports
// (e.g. `@src/core/constants`).
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
  if (request === "@src/core") {
    return originalResolveFilename.call(this, path.join(CORE_SRC, "index.ts"), parent, isMain, options);
  }
  if (request.startsWith("@src/core/")) {
    const sub = request.slice("@src/core/".length);
    return originalResolveFilename.call(this, path.join(CORE_SRC, sub), parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

// Minimal transpile-on-require for .ts: single-file syntactic transpile only
// (no type-checking -- this is a test harness, not a build), mirroring this
// repo's tsconfig.base.json `module`/`esModuleInterop` settings.
require.extensions[".ts"] = function transpileAndCompile(mod, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  mod._compile(outputText, filename);
};

module.exports = { CORE_SRC };

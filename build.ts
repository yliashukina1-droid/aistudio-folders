/**
 * Bundles src/index.ts into a single Tampermonkey userscript.
 *
 * The bundle is built in memory (no `outdir`) so the only file this script ever
 * writes is the finished userscript — an intermediate dist/index.js would
 * otherwise be shipped as a stray release artifact.
 */
import pkg from "./package.json" with { type: "json" };

const OUT_FILE = "./dist/aistudio-folders.user.js";

/** `@version` is read from package.json so the git tag, the manifest and the
 * userscript's update check can never drift apart. */
const META = `// ==UserScript==
// @name         AI Studio — Folders for History (Pro UI/UX)
// @namespace    aistudio-folders
// @version      ${pkg.version}
// @description  ${pkg.description}
// @match        https://aistudio.google.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

`;

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  minify: true,
  target: "browser",
  throw: false,
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const [bundle] = result.outputs;
if (!bundle) {
  console.error("Build produced no output.");
  process.exit(1);
}

const bytes = await Bun.write(OUT_FILE, META + (await bundle.text()));

console.log(`⚡ Built ${OUT_FILE} (v${pkg.version}, ${(bytes / 1024).toFixed(1)} kB)`);

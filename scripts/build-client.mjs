
import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs/promises";

async function build() {
  await fs.mkdir("dist", { recursive: true });

  const result = await esbuild.build({
    entryPoints: ["src/client/index.ts"],
    bundle: true,
    format: "cjs",
    target: "es2022",
    external: [
      "react",
      "react/jsx-runtime",
      "@deepseek-ai/*",
      "cordis",
      "@deepseek-ai/cordis"
    ],
    banner: {
      js: `window.__ModuleLoader__.load({
  id: "dsh-agent-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`
    },
    footer: {
      js: `    return module.exports;
  }
});`
    },
    outfile: "dist/client.js",
    sourcemap: true,
    write: true
  });

  console.log("Built dist/client.js successfully");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

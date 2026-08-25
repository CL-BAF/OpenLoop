import {build} from "esbuild";
import {copyFile, mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(repository, "packages", "opencode-plugin", "dist", "openloop.js");
const checkoutPlugin = join(repository, ".opencode", "plugins", "openloop.js");

await build({
  entryPoints: [join(repository, "packages", "opencode-plugin", "src", "loader.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  legalComments: "none",
  banner: {js: "// Generated self-contained OpenLoop plugin. Run npm run build to refresh."},
});

// Some bundled dependencies contain indented blank lines inside template literals.
// Normalize only those blank lines so the checked-in artifact remains diff-clean.
const bundled = await readFile(output, "utf8");
await writeFile(output, bundled.replace(/^[\t ]+(?=\r?$)/gm, ""), "utf8");

await mkdir(dirname(checkoutPlugin), {recursive: true});
await copyFile(output, checkoutPlugin);

import {existsSync} from "node:fs";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPlugin = join(repository, "packages", "opencode-plugin", "dist", "openloop.js");

export async function installProject(targetDirectory, options = {}) {
  const target = resolve(targetDirectory);
  const pluginPath = resolve(options.pluginPath ?? defaultPlugin);
  if (!existsSync(pluginPath)) {
    throw new Error(`Built plugin not found at ${pluginPath}. Run npm install or npm run build first.`);
  }
  const targetInfo = await stat(target).catch(() => null);
  if (!targetInfo?.isDirectory()) throw new Error(`Target project directory does not exist: ${target}`);

  const destination = join(target, ".opencode", "plugins", "openloop.js");
  const contents = await readFile(pluginPath, "utf8");

  if (existsSync(destination)) {
    const current = await readFile(destination, "utf8");
    if (current === contents) return {destination, changed: false};
    if (!options.force) {
      throw new Error(`Refusing to overwrite existing plugin file: ${destination}. Re-run with --force only if you intend to replace it.`);
    }
  }
  await mkdir(dirname(destination), {recursive: true});
  await writeFile(destination, contents, "utf8");
  return {destination, changed: true};
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const targets = args.filter((arg) => arg !== "--force");
  if (targets.length !== 1) {
    throw new Error('Usage: npm run install:project -- "C:\\path\\to\\project" [--force]');
  }
  const result = await installProject(targets[0], {force});
  process.stdout.write(result.changed
    ? `Installed self-contained OpenLoop plugin at ${result.destination}\nRestart OpenCode/Desktop and open that project.\n`
    : `OpenLoop plugin is already current at ${result.destination}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`OpenLoop installation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

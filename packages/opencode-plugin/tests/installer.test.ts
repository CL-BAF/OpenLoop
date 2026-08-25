import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {installProject} from "../../../scripts/install-project.mjs";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "openloop-install-")); });
afterEach(() => { rmSync(dir, {recursive: true, force: true}); });

describe("project-local installer", () => {
  it("builds a discovered module with only the plugin factory exported", async () => {
    const modulePath = join(process.cwd(), "packages", "opencode-plugin", "dist", "openloop.js");
    const pluginModule = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
    expect(Object.keys(pluginModule)).toEqual(["OpenLoopPlugin"]);
  });

  it("copies a self-contained bundle and is idempotent", async () => {
    const target = join(dir, "target");
    const source = join(dir, "plugin.js");
    writeFileSync(source, "export {};", "utf8");
    mkdirSync(target);

    const first = await installProject(target, {pluginPath: source});
    const second = await installProject(target, {pluginPath: source});
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(readFileSync(first.destination, "utf8")).toBe("export {};");
  });

  it("preserves an unrelated existing plugin file unless force is explicit", async () => {
    const source = join(dir, "plugin.js");
    const target = join(dir, "target");
    const destination = join(target, ".opencode", "plugins", "openloop.js");
    mkdirSync(join(target, ".opencode", "plugins"), {recursive: true});
    writeFileSync(source, "export {};", "utf8");
    writeFileSync(destination, "// user file\n", "utf8");

    await expect(installProject(target, {pluginPath: source})).rejects.toThrow("Refusing to overwrite");
    expect(readFileSync(destination, "utf8")).toBe("// user file\n");
    await expect(installProject(target, {pluginPath: source, force: true})).resolves.toMatchObject({changed: true});
  });
});

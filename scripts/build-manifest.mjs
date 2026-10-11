import { readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

const directory = process.argv[2];
if (directory !== "dist") throw new Error("Dedicated dist directory required");
const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const files = {};
async function collect(relative = "") {
  for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) await collect(name);
    else if (entry.isFile() && name !== "build-manifest.json") {
      const bytes = await readFile(join(directory, name));
      if (process.env.PAGES_BUILD === "1" && (name === "main.wasm" || bytes.length >= 25 * 1024 * 1024)) throw new Error(`Pages artifact rejected: ${name}`);
      files[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    } else if (!entry.isFile()) throw new Error("Unexpected artifact entry");
  }
}
await collect();
const manifest = {
  version: JSON.parse(await readFile("package.json", "utf8")).version,
  sourceSHA: run("git", ["rev-parse", "HEAD"]),
  dirty: Boolean(run("git", ["status", "--porcelain", "--untracked-files=normal"])),
  goVersion: run("go", ["env", "GOVERSION"]),
  modules: run("go", ["list", "-m", "all"]).split("\n"),
  files,
};
await writeFile(join(directory, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

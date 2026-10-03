import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

test("production imports use only published Ditto entrypoints and locked registry artifact", async () => {
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.equal(
    lock.packages["node_modules/@codesoul-co/ditto"].version,
    "0.1.2",
  );
  assert.equal(
    lock.packages["node_modules/@codesoul-co/ditto"].resolved,
    "https://registry.npmjs.org/@codesoul-co/ditto/-/ditto-0.1.2.tgz",
  );
  assert.ok(lock.packages["node_modules/@codesoul-co/ditto"].integrity);
  const allowed = new Set([
    "@codesoul-co/ditto",
    "@codesoul-co/ditto/worker/infer",
  ]);
  for (const file of await readdir("src")) {
    const text = await readFile(`src/${file}`, "utf8");
    for (const match of text.matchAll(/from ['"]([^'"]+)['"]/g)) {
      const name = match[1];
      if (name.includes("ditto"))
        assert.ok(
          allowed.has(name) || name === "./ditto.js" || name === "./ditto-guide.js",
          `Invalid Ditto import in ${file}: ${name}`,
        );
      assert.ok(
        !name.includes("/src/") &&
          !name.includes("/dist/") &&
          !name.includes("/codespace/Ditto"),
      );
    }
  }
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { netFor, TAILNET_RANGE } from "../src/loop.ts";
import { CFG, settingsText } from "./helpers.ts";

// X7 (#902): softnetBlock is gone. Every VM is blocked from the box's public addresses and the
// tailnet, and a taskbox.json that still names the field is refused, so no block is dropped unsaid.
function dirWith(text: string): string {
  const d = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
  writeFileSync(join(d, "taskbox.json"), text);
  return d;
}

describe("softnetBlock", () => {
  test("a taskbox.json that names it is refused, with or without a list", () => {
    for (const v of [[], ["198.18.0.0/16"], null, "10.0.0.0/8"]) {
      const s = JSON.parse(settingsText());
      s.softnetBlock = v;
      expect(() => loadConfig(dirWith(JSON.stringify(s)))).toThrow("taskbox.json: softnetBlock is gone: every VM is blocked from the box, its public address and the tailnet already");
    }
  });

  test("without it, the settings load", () => {
    expect(() => loadConfig(dirWith(settingsText()))).not.toThrow();
  });

  test("the box's own taskbox.json and the example both load", () => {
    for (const f of ["taskbox.json", "taskbox.example.json"]) {
      let text: string;
      try {
        text = readFileSync(join(import.meta.dir, "..", f), "utf8");
      } catch {
        continue; // the public copy has no taskbox.json
      }
      expect(() => loadConfig(dirWith(text))).not.toThrow();
    }
  });

  test("a VM is blocked from exactly the box's address and the tailnet", () => {
    expect(netFor(CFG, ["203.0.113.7"]).block).toEqual(["203.0.113.7/32", TAILNET_RANGE]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Contract tests for crit 5 ("A game"). They retire with this week's brief;
// see spec/README.md. Run against the BUILT site, like the invariants.
const DIST = resolve("dist");

function files(dir: string = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const shipped = files().map((path) => relative(DIST, path).split(sep).join("/"));

const pages = shipped
  .filter((name) => name.endsWith(".html"))
  .map((name) => ({
    name,
    doc: new JSDOM(readFileSync(join(DIST, name), "utf8")).window.document,
  }));

describe("crit 5: no how-to-play stands in for the opening screen", () => {
  it("ships no page named after instructions or how-to-play", () => {
    const instructionPage = shipped.find((name) =>
      /how-?to-?play|instructions|rules|tutorial/i.test(name),
    );
    expect(
      instructionPage,
      "the brief rules out an instructions page — the opening screen has to make the first move obvious instead",
    ).toBeUndefined();
  });

  for (const { name, doc } of pages) {
    it(`${name}: has no how-to-play modal or dialog`, () => {
      const modal = doc.querySelector(
        '[role="dialog"], dialog, [class*="how-to-play" i], [class*="instructions" i], [id*="how-to-play" i], [id*="instructions" i]',
      );
      expect(
        modal,
        "no modal or dialog may stand in for the opening screen teaching the player",
      ).toBeNull();
    });
  }
});

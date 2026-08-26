/**
 * Unit tier — the prompts, and the seam between them and the parser.
 *
 * THE ONE THAT MATTERS IS `the prompt and the parser agree`. The prompts tell
 * the model to emit a heading; `journal.openItemsOf` finds carry-forward by
 * matching one. They live in different files, neither imports the other, and
 * nothing but this test connects them — so either can be reworded on its own
 * and the result is not an error. It is a brief with no carryover, which reads
 * exactly like a day with nothing open.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { freshImport } from "../support/sandbox.mjs";

const CRITERIA = ["BRIEF_CRITERIA", "WRAP_CRITERIA"];

describe("the prompt and the parser agree about OPEN ITEMS", () => {
  for (const name of CRITERIA) {
    test(`${name}'s heading is one openItemsOf actually finds`, async () => {
      const prompts = await freshImport("prompts.mjs");
      const { openItemsOf } = await freshImport("journal.mjs");

      // Extract the heading the prompt instructs the model to emit, and feed
      // the parser a document shaped the way that instruction describes.
      const heading = /^#{1,6}\s*OPEN ITEMS\s*$/m.exec(prompts[name]);
      assert.ok(heading, `${name} no longer names an OPEN ITEMS heading at all`);

      const entry = `# Start of day\n\n## Due\nsomething above\n\n${heading[0]}\n\n- [2026-01-02] a thing — first seen 2026-01-01\n`;
      const carried = openItemsOf(entry);

      assert.match(carried, /first seen 2026-01-01/, "the parser did not carry the items forward");
      assert.equal(
        carried.includes("something above"),
        false,
        "the parser did not find the heading and fell back to the whole entry — " +
          "carry-forward still 'works' but is now the entire previous brief",
      );
    });
  }
});

describe("both runs ask for the same record", () => {
  for (const name of CRITERIA) {
    test(`${name} demands the OPEN ITEMS section even when empty`, async () => {
      /* An optional section is one the model omits on a quiet day, and a
         missing section is indistinguishable from nothing being open. */
      const prompts = await freshImport("prompts.mjs");
      assert.match(prompts[name], /always present even if empty/i);
    });

    test(`${name} carries the ORIGINAL first-seen date forward`, async () => {
      /* Re-stating the date every day is the mechanism. Without it nothing can
         say "open for four days" — the only reason the pair exists. */
      const prompts = await freshImport("prompts.mjs");
      assert.match(prompts[name], /first seen/i);
      assert.match(prompts[name], /ORIGINAL/);
    });

    test(`${name} refuses invention and requires a named source`, async () => {
      /* This runs unattended and its output is read at 7am by someone deciding
         what to do today. An invented deadline is not cosmetic. */
      const prompts = await freshImport("prompts.mjs");
      assert.match(prompts[name], /NEVER INVENT/);
      assert.match(prompts[name], /## Sources/);
      assert.match(prompts[name], /not optional/i);
    });

    test(`${name} keeps "waiting on me" separate from "waiting on them"`, async () => {
      const prompts = await freshImport("prompts.mjs");
      assert.match(prompts[name], /DISTINGUISH WHO OWES WHOM|Waiting on someone else|blocked on me/i);
    });
  }

  test("the two prompts are not the same prompt", async () => {
    /* They are the same job seen from both ends; a copy-paste that made them
       identical would still satisfy every assertion above. */
    const { BRIEF_CRITERIA, WRAP_CRITERIA } = await freshImport("prompts.mjs");
    assert.notEqual(BRIEF_CRITERIA, WRAP_CRITERIA);
    assert.match(BRIEF_CRITERIA, /start-of-day/i);
    assert.match(WRAP_CRITERIA, /end-of-day/i);
    assert.match(WRAP_CRITERIA, /## Slipped/);
  });

  test("the shared ground rules really are shared", async () => {
    const { BRIEF_CRITERIA, WRAP_CRITERIA } = await freshImport("prompts.mjs");
    for (const rule of ["NEVER INVENT", "DATES ARE VERBATIM", "DISTINGUISH WHO OWES WHOM"]) {
      assert.match(BRIEF_CRITERIA, new RegExp(rule), `brief lost: ${rule}`);
      assert.match(WRAP_CRITERIA, new RegExp(rule), `wrap lost: ${rule}`);
    }
  });
});

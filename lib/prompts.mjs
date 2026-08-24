/**
 * The briefs, kept here rather than retyped per invocation.
 *
 * A summary whose brief changes every morning is a summary you cannot compare
 * with yesterday's — and the entire value of running this twice a day is that
 * the same question, asked the same way, makes a drift visible. "Still open,
 * fourth day" is only a sentence anything can produce if the two days were
 * asked the same thing.
 */

/**
 * Rules that apply to both runs.
 *
 * The first one carries the most weight and is not a style note. This runs
 * unattended, and its output is read at 7am by someone deciding what to do
 * today — so an invented deadline is not a cosmetic defect, it is the tool
 * actively making the day worse. A blank section is a *useful* answer; a
 * plausible one that no source supports is not, and the two are
 * indistinguishable once they are in the file.
 */
const GROUND_RULES = `Ground rules, in order of importance:

1. NEVER INVENT. Every item must trace to something you actually read. Cite it inline — the sender and subject, the document name, the issue key. If you could not reach a source, or a source returned nothing, SAY SO EXPLICITLY under "Sources" and leave the section empty. An empty section is a correct answer. A plausible item nobody can trace is worse than no summary at all, because it will be acted on.
2. DATES ARE VERBATIM. Quote a deadline in the words the source used, then add the resolved calendar date in parentheses if it is unambiguous. If a date is relative ("end of week", "next sprint") and you cannot resolve it confidently, keep it relative and mark it UNRESOLVED rather than guessing.
3. DISTINGUISH WHO OWES WHOM. An item where someone is waiting on me is not the same as one where I am waiting on someone else, and the second kind is what silently rots. Keep them apart.
4. BE SHORT AND CONCRETE. One line per item. No preamble, no encouragement, no restating these instructions. If there is nothing to say, the whole answer may be three lines.
5. NO SPECULATION ABOUT PRIORITY unless the source states it. Do not promote something to urgent because it sounds urgent.`;

/** The trailing block `lib/journal.mjs` carries forward. Both runs emit it. */
const OPEN_ITEMS_BLOCK = `Finish with this section, exactly this heading, always present even if empty:

## OPEN ITEMS

One line each, in this shape, sorted by date with undated last:

- [DATE or "no date"] <what> — <who owes whom> — <source> — first seen <YYYY-MM-DD>

Carry forward every item from the previous entries that is still open, keeping its ORIGINAL "first seen" date. That date is the whole point of this section: it is the only way anything can show that a task has been open for four days. Drop an item only when a source shows it closed, and when you drop one, say why in a "Closed today" line above the section.`;

export const BRIEF_CRITERIA = `You are producing my start-of-day brief. Read the sources available to you and tell me what today needs.

${GROUND_RULES}

Produce exactly these sections:

## Due or overdue
Anything with a date that is today, before today, or within the next two working days. Overdue first, and say how late. This section is the reason the brief exists — if it is empty, say "nothing dated in range" rather than padding it.

## Needs a decision or reply from me
Things blocked on me specifically. Name who is waiting and since when.

## New since the last entry
What arrived since the previous journal entry that I have not already seen in it. Skip anything already listed there unless its status changed.

## Waiting on someone else
Things I have asked for and not received. Include how long it has been.

## Sources
One line per source: what you read, and the count (for example "mail: 34 messages since 17:00 yesterday"). Name explicitly any source you could NOT reach. This section is not optional.

${OPEN_ITEMS_BLOCK}`;

export const WRAP_CRITERIA = `You are producing my end-of-day wrap. Read the sources available to you, and today's earlier journal entry if there is one, and record what actually happened.

${GROUND_RULES}

Produce exactly these sections:

## Done today
What visibly completed — merged, sent, filed, answered. Evidence for each.

## Moved but not finished
Things that progressed and what the next step is.

## Arrived today and not yet handled
New requests, new deadlines. This is the feed for tomorrow's brief, so be complete here even where you are brief elsewhere.

## Slipped
Anything that was on this morning's brief and did not move. Say how many days it has now been open. Do not editorialise; just count.

## Tomorrow's dated items
Anything due tomorrow or the next working day.

## Sources
One line per source with counts, and any source you could not reach. Not optional.

${OPEN_ITEMS_BLOCK}`;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipSections, planHandoff, clippingReceipt, RECEIPT_RESERVE } from '../lib/section-budget.js';
import { clip, TRUNCATION_MARKER } from '../lib/text.js';

/** The sections the host's compaction directive mandates, in its order. */
const SECTIONS = [
  'Primary Request and Intent', 'Key Technical Concepts', 'Files and Code',
  'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context',
];
/** Section sizes two live rotations produced, in the same order: the reply is
 * ~15.7k characters against a ~12.9k grant, and the cut used to land at 12 937 —
 * inside `## Next Step`, deleting `## Critical Context` outright. */
const LIVE_SIZES = [1331, 2229, 4708, 3356, 300, 936, 512, 2336];
const LIVE_BUDGET = 12937;
/** The smallest budget the sectioned layout can be admitted at for this fixture. */
const ADMITTED = 372;

/** Exactly `chars` characters of section: its heading, then short bullets. */
function section(title, chars) {
  const head = `## ${title}\n`;
  const room = chars - head.length;
  if (room <= 0) return head;
  const bullet = `- ${title.toLowerCase()} detail\n`;
  return head + bullet.repeat(Math.ceil(room / bullet.length)).slice(0, room);
}

const handoff = (sizes = LIVE_SIZES) => sizes.map((n, i) => section(SECTIONS[i], n)).join('\n');
const headingsOf = text => [...text.matchAll(/^## (.+)$/gm)].map(m => m[1]);
/** The rendered slice of one section: its heading line up to the next heading. */
function sliceOf(text, title) {
  const start = text.indexOf(`## ${title}\n`);
  const next = text.indexOf('\n## ', start);
  return text.slice(start, next === -1 ? text.length : next);
}
/** Fence delimiter lines, so an odd count is an open block. */
const fenceLines = text => (text.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? []).length;
/** An independent fence-aware heading reader: what a markdown parser — and the
 * next compaction — will actually treat as a section heading. */
function recognisedHeadings(text) {
  const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  let open = null;
  const found = [];
  for (const line of text.split('\n')) {
    const match = fence.exec(line);
    if (open !== null) {
      if (match !== null && match[1][0] === open[0] && match[1].length >= open.length && /^[ \t]*$/.test(match[2])) open = null;
      continue;
    }
    if (match !== null) {
      if (!(match[1][0] === '`' && match[2].includes('`'))) open = match[1];
      continue;
    }
    const heading = /^ {0,3}## (.+)$/.exec(line);
    if (heading !== null) found.push(heading[1].replace(/[ \t]+#+[ \t]*$/, '').trim());
  }
  return found;
}

test('a handoff that fits is returned unchanged, byte for byte', () => {
  const text = handoff();
  assert.equal(clipSections(text, text.length), text);
  assert.equal(clipSections(text, text.length + 1), text);
  assert.equal(clipSections(text, 1_000_000), text);
  // CRLF bodies round-trip too: the pieces are cut by offset, never re-joined by guess.
  const crlf = handoff().replace(/\n/g, '\r\n');
  assert.equal(clipSections(crlf, crlf.length), crlf);
});

test('an overrun keeps every mandated section and spends the budget on the expendable one', () => {
  const plan = planHandoff(handoff(), LIVE_BUDGET);
  assert.ok(plan.text.length <= LIVE_BUDGET, `${plan.text.length} > ${LIVE_BUDGET}`);
  assert.deepEqual(recognisedHeadings(plan.text), SECTIONS);
  // The sections that carry decisions, the next action and the current state are
  // the ones the old tail cut deleted first; here they survive whole.
  for (const title of ['Critical Context', 'Next Step', 'Current Work']) {
    const piece = plan.pieces.find(p => p.name === title);
    assert.equal(piece.kept, piece.original, `${title} was shortened`);
  }
  // Files and Code is what pays for it.
  assert.ok(sliceOf(plan.text, 'Files and Code').includes(TRUNCATION_MARKER));
});

test('the tail cut this replaces is pinned: it deleted Critical Context outright', () => {
  const text = handoff();
  // Regression evidence from the live rotation, reproduced on the same sizes.
  assert.ok(!clip(text, LIVE_BUDGET).includes('## Critical Context'));
  assert.ok(clipSections(text, LIVE_BUDGET).includes('## Critical Context'));
});

test('a trimmed section ends on a bullet boundary instead of mid-word', () => {
  const files = sliceOf(clipSections(handoff(), LIVE_BUDGET), 'Files and Code');
  assert.ok(files.includes(`detail\n${TRUNCATION_MARKER}`), JSON.stringify(files.slice(-60)));
});

test('no budget leaves a fence open, so every section is still recognised', () => {
  // The cut lands inside the fenced block at some budgets. An open fence would turn
  // every following heading into code, and the NEXT compaction would lose them.
  const text = handoff().replace('## Files and Code\n',
    `## Files and Code\n- path: lib/x.js\n\`\`\`js\n${'const x = 1;\n'.repeat(60)}\`\`\`\n- after the block\n`);
  for (let budget = ADMITTED; budget <= text.length; budget += 29) {
    const plan = planHandoff(text, budget);
    assert.ok(plan.text.length <= budget, `budget ${budget}: ${plan.text.length}`);
    assert.equal(fenceLines(plan.text) % 2, 0, `budget ${budget}: an open fence survived`);
    if (plan.sectioned) assert.deepEqual(recognisedHeadings(plan.text), SECTIONS, `budget ${budget}`);
    const again = planHandoff(plan.text, Math.max(ADMITTED, Math.floor(budget / 2)));
    assert.equal(fenceLines(again.text) % 2, 0, `budget ${budget}: re-clip left a fence open`);
    if (again.sectioned) assert.deepEqual(recognisedHeadings(again.text), SECTIONS, `budget ${budget} re-clip`);
  }
});

test('a fence the reply never closed is closed for it', () => {
  const text = '## Files and Code\n```js\nunclosed code\n## Critical Context\nz';
  for (const budget of [100_000, 400]) {
    const plan = planHandoff(text, budget);
    assert.equal(fenceLines(plan.text) % 2, 0, `budget ${budget}: ${JSON.stringify(plan.text.slice(-30))}`);
  }
});

test('a shortened piece always says so, and a short one is never emptied', () => {
  const text = SECTIONS
    .map((title, i) => (i === 4 ? '## Pending Jobs\n(none)' : section(title, LIVE_SIZES[i]))).join('\n');
  for (let budget = ADMITTED; budget <= 6_000; budget += 53) {
    const plan = planHandoff(text, budget);
    if (!plan.sectioned) continue;
    // Regression: a six-character body used to be scaled below the marker length and
    // returned empty, so its content vanished with no trace at all.
    const pending = plan.pieces.find(piece => piece.name === 'Pending Jobs');
    assert.equal(pending.kept, pending.original, `budget ${budget}: Pending Jobs was emptied`);
    for (const piece of plan.pieces) {
      if (piece.kept === piece.original || piece.lead) continue;
      assert.ok(sliceOf(plan.text, piece.name).includes(TRUNCATION_MARKER),
        `budget ${budget}: ${piece.name} lost text without a marker`);
    }
  }
});

test('unrecognized headings cannot outspend the mandated structure', () => {
  const base = ['## Critical Context', 'c'.repeat(3000), '## Files and Code', 'f'.repeat(3000)];
  const withUnknown = n => [...base,
    ...Array.from({ length: n }, (_, i) => [`## Ad hoc ${i}`, 'a'.repeat(300)]).flat()].join('\n');
  const critical = n => planHandoff(withUnknown(n), 5_000).pieces.find(p => p.name === 'Critical Context').kept;
  assert.equal(critical(0), 3000);
  // Regression: twenty and sixty ad-hoc headings used to starve Critical Context to
  // 1 281 and 70 characters by each claiming a floor of their own.
  assert.ok(critical(20) > 2_500, `critical(20) = ${critical(20)}`);
  assert.ok(critical(60) > 2_000, `critical(60) = ${critical(60)}`);
});

test('a duplicated protected heading shares one entitlement', () => {
  const text = [
    section('Critical Context', 900), section('Critical Context', 900),
    section('Files and Code', 900),
    ...Array.from({ length: 20 }, (_, i) => section(`Ad hoc ${i}`, 300)),
  ].join('\n');
  const out = clipSections(text, 2_000);
  assert.ok(out.length <= 2_000);
  assert.ok(sliceOf(out, 'Files and Code').includes(TRUNCATION_MARKER) || out.length > 1_500);
});

test('a long preamble is not protected whole while the sections starve', () => {
  const text = `- ${'lead '.repeat(400)}\n${handoff()}`;
  const plan = planHandoff(text, LIVE_BUDGET);
  assert.ok(plan.text.length <= LIVE_BUDGET);
  assert.deepEqual(recognisedHeadings(plan.text), SECTIONS);
  assert.ok(plan.text.startsWith('- lead lead'));
  assert.ok(plan.text.includes('## Critical Context'));
});

test('surrogate pairs are never split in half', () => {
  const text = ['## Primary Request and Intent', '🚀'.repeat(400), '## Critical Context', '🛰'.repeat(400)].join('\n');
  for (let budget = 60; budget < 400; budget += 7) {
    const out = clipSections(text, budget);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), `lone surrogate at ${budget}`);
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), `lone surrogate at ${budget}`);
  }
});

test('the clip never exceeds its budget, however small', () => {
  const fixtures = [
    handoff(),
    'L\n## Files and Code\n```\n' + 'x'.repeat(1_000) + '\n```\n## Critical Context\nz',
    'x'.repeat(500),
  ];
  for (const text of fixtures) {
    for (const budget of [0, 1, 5, 13, 20, 41, 100, 210, 1_000]) {
      assert.ok(clipSections(text, budget).length <= budget, `${budget}: ${clipSections(text, budget).length}`);
    }
  }
});

test('a reply that ignores the mandated structure falls back to the plain clip', () => {
  const flat = 'x'.repeat(3_000);
  assert.equal(clipSections(flat, 1_000), clip(flat, 1_000));
  // One heading is not a sectioned handoff.
  const single = `## Only One\n${'y'.repeat(3_000)}`;
  assert.equal(clipSections(single, 1_000), clip(single, 1_000));
  assert.equal(planHandoff(single, 1_000).fallback, 'sections');
  // Nor is a budget the heading overhead and the marker reservations consume.
  assert.equal(planHandoff(handoff(), 20).fallback, 'structure');
  // An unclosed fence hides the headings after it, so the layout is not sectioned —
  // but the fallback clip still closes the fence rather than handing it on.
  const dangling = `## Primary Request and Intent\n\`\`\`\n## Critical Context\n- z\n${'z'.repeat(2_000)}`;
  const plan = planHandoff(dangling, 1_000);
  assert.equal(plan.fallback, 'sections');
  assert.equal(fenceLines(plan.text) % 2, 0);
});

test('a `## ` line inside a fenced block is content, not a section', () => {
  const text = [
    section('Primary Request and Intent', 900),
    '```md', '## Not a section', '```',
    section('Critical Context', 900),
  ].join('\n');
  assert.equal(clipSections(text, text.length), text);
  assert.deepEqual(recognisedHeadings(clipSections(text, 1_200)), ['Primary Request and Intent', 'Critical Context']);
});

test('a longer fence is not closed by a shorter run of the same character', () => {
  const text = [
    section('Primary Request and Intent', 400),
    '````md', '```', '## Not a section', '```', '````',
    section('Critical Context', 400),
  ].join('\n');
  assert.deepEqual(recognisedHeadings(clipSections(text, 600)), ['Primary Request and Intent', 'Critical Context']);
});

test('a space that is not a space does not close a fence', () => {
  // Only spaces or tabs may follow a closing delimiter. Reading a full-width space as
  // one ends the block early, and every code line after it becomes a section heading.
  const text = [
    section('Primary Request and Intent', 400),
    '```md', '## Not a section', '```\u3000',
    section('Critical Context', 400),
  ].join('\n');
  for (const budget of [text.length, 600]) {
    assert.deepEqual(recognisedHeadings(clipSections(text, budget)), ['Primary Request and Intent']);
  }
});

test('a CRLF body gets the same fence repair as an LF one', () => {
  // A carriage return is a line ending too, and `.` does not match it: a delimiter
  // line ending in CR was invisible to the repair, so the block stayed open and the
  // `## ` lines inside it were read as sections.
  const unclosed = ['## A', 'a'.repeat(30), '```js', 'code', '## B', 'b'.repeat(20)].join('\r\n') + '\r\n';
  for (const budget of [40, 60, 80, 100]) {
    assert.equal(fenceLines(clipSections(unclosed, budget)) % 2, 0, `budget ${budget}: an open fence survived`);
  }
  const fenced = ['## Primary Request and Intent', 'p'.repeat(300), '```md', '## Not a section', '```',
    '## Critical Context', 'c'.repeat(300)].join('\r\n');
  const plan = planHandoff(fenced, 400);
  assert.deepEqual(plan.pieces.map(piece => piece.name), ['Primary Request and Intent', 'Critical Context']);
  assert.equal(fenceLines(plan.text) % 2, 0);
});

test('a piece the fence repair emptied is reported, not called whole', () => {
  // The repair retreats out of a block it cannot close inside the piece's grant. The
  // text is gone either way, but a receipt that counted it as kept overstates the
  // handoff: this reported "7 of 36 kept" while 2 characters had survived.
  const text = `## A\n${'a'.repeat(20)}\n## B\n\`\`\`\nx`;
  const plan = planHandoff(text, 32);
  assert.equal(plan.sectioned, true);
  const piece = plan.pieces.find(item => item.name === 'B');
  assert.deepEqual(
    { kept: piece.kept, original: piece.original, shortened: piece.shortened },
    { kept: 0, original: 5, shortened: true });
  assert.equal(plan.keptSource, plan.pieces.reduce((sum, item) => sum + item.kept, 0));
  assert.match(clippingReceipt(plan), /2 of 36/);
});

test('the fallback clip reports source characters, not the marker that marks them', () => {
  // The clip spends budget on the marker itself, so the excerpt is longer than the
  // text it kept: this reported 98 of 1 000 when 85 characters of the reply survived.
  const plan = planHandoff('x'.repeat(1_000), 100);
  assert.equal(plan.text.length, 98);
  assert.equal(plan.keptSource, 85);
  assert.match(clippingReceipt(plan), /85 of 1000 source characters kept/);
});

test('a repair that would empty the excerpt hands the excerpt on instead', () => {
  // Deleting every character protects no following heading — the cut already ends the
  // text — and it cost the next window its handoff body outright. The receipt still
  // reports the source characters the repair got to keep.
  const body = `\`\`\`js\n${'x'.repeat(1_000)}`;
  const out = clipSections(body, 100);
  assert.equal(out.length, 98);
  assert.ok(out.startsWith('```js\n'));
  assert.equal(planHandoff(body, 100).keptSource, 85);
  // The same guard keeps an excerpt that fits the budget in one piece.
  assert.equal(clipSections('```\nx', 5), '```\nx');
});

test('an empty section keeps its heading rather than vanishing', () => {
  const text = ['## A', '## B', '## Files and Code', 'x'.repeat(2_000)].join('\n');
  const out = clipSections(text, 300);
  assert.deepEqual(recognisedHeadings(out), ['A', 'B', 'Files and Code']);
  assert.ok(out.length <= 300);
});

test('the clipping receipt fits its reservation and names the fallback reason', () => {
  const text = handoff();
  for (let budget = 400; budget <= text.length; budget += 313) {
    const plan = planHandoff(text, budget);
    const receipt = clippingReceipt(plan);
    assert.ok(receipt.length <= RECEIPT_RESERVE, `receipt ${receipt.length} at ${budget}`);
    assert.match(receipt, /^<clipping_receipt>[\s\S]*<\/clipping_receipt>$/);
    if (plan.sectioned && plan.pieces.some(piece => piece.shortened)) assert.match(receipt, /Clipped by priority/);
  }
  // The reason is the one that actually applied, not a guess about the reply.
  assert.match(clippingReceipt(planHandoff(text, 20)), /the sectioned layout did not fit the budget/);
  assert.match(clippingReceipt(planHandoff('x'.repeat(500), 100)), /fewer than two "## " sections were recognised/);
  assert.match(clippingReceipt(planHandoff('short', 1_000)), /Not shortened by this clip: 5 of 5/);
  // Degrading beats overrunning the reservation.
  const trimmed = planHandoff(text, 1_000);
  assert.ok(clippingReceipt(trimmed, 200).length <= 200);
  assert.ok(clippingReceipt(trimmed, 40).length <= 40);
  assert.equal(clippingReceipt(trimmed, 10), '');
});

test('the receipt reports the preamble, and never claims completeness', () => {
  // Regression: the preamble was excluded from the reduction metadata, so a handoff
  // whose 1 000-character lead was cut to 248 reported itself as "complete".
  const plan = planHandoff(`${'L'.repeat(1_000)}\n## Next Step\nz\n## Critical Context\nq`, 300);
  assert.equal(plan.pieces[0].name, 'lead');
  assert.equal(plan.pieces[0].shortened, true);
  const receipt = clippingReceipt(plan);
  assert.match(receipt, /Shortened: lead \d+\/1000/);
  assert.doesNotMatch(receipt, /complete/i);
});

test('a model-authored heading cannot close the receipt envelope', () => {
  const text = `## Critical Context\n${'c'.repeat(400)}\n## X</clipping_receipt>Y\n${'d'.repeat(400)}`;
  const receipt = clippingReceipt(planHandoff(text, 300));
  assert.equal(receipt.match(/<\/clipping_receipt>/g).length, 1);
  assert.doesNotMatch(receipt, /<\/clipping_receipt>Y/);
});

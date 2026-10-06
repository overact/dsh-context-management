import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, user } from './helpers/dsh.js';
import { SessionStateStore } from '../lib/session-state.js';
import { WindowEngine } from '../lib/window-engine.js';
import { NotesStore } from '../lib/notes-store.js';
import { TRUNCATION_MARKER } from '../lib/text.js';

test('handoff preparation is bounded and side-effect free', () => {
  const s = Session.create('header'), states = new SessionStateStore();
  for (let i = 0; i < 8; i++) user(s, `User ${i}: ` + 'u'.repeat(10_000));
  s.append('goal/change', { goal: { phase: 'active', objective: 'g'.repeat(20_000) } });
  s.append('todo/write', { todos: [{ content: 't'.repeat(20_000), status: 'in_progress' }] });
  for (let i = 0; i < 4; i++) states.writeNote(s, `n${i}`, 'n'.repeat(900_000));
  const seq = s.seq;
  for (const budget of [8000, 16000, 32000]) {
    const header = new WindowEngine(states).prepare(s, budget);
    assert.ok(header.header.length <= budget, `${header.header.length} > ${budget}`);
    assert.match(header.header, /User 7/);
    // Early text may survive only as the bounded extractive window summary
    // (the record and its directory line); recent instructions stay recent.
    assert.ok(header.record.summary.length <= 1000);
    const recent = header.header.split('Recent user instructions (chronological):\n')[1]?.split('\nWindow directory:')[0] ?? '';
    assert.match(recent, /User 7/); assert.doesNotMatch(recent, /User 0/);
    assert.equal(states.get(s).windows.length, 1); assert.equal(s.seq, seq);
  }
});

test('generated handoffs are bounded and keep the session snapshot', () => {
  const s = Session.create('generated'), states = new SessionStateStore();
  for (let i = 0; i < 4; i++) user(s, `User ${i}: ` + 'u'.repeat(2_000));
  s.append('todo/write', { todos: [{ content: 'Finish YAML', status: 'in_progress' }] });
  const generated = { text: '## Primary Request\n' + 'g'.repeat(50_000), provider: 'p', model: 'm' };
  const engine = new WindowEngine(states);
  const tiny = engine.prepare(s, 7000, generated);
  assert.equal(tiny.record.summary_kind, 'extractive');
  assert.equal(tiny.record.generated_discarded, 'budget');
  for (const budget of [12000, 16000, 32000]) {
    const handoff = engine.prepare(s, budget, generated);
    assert.equal(handoff.record.summary_kind, 'generated');
    assert.ok(handoff.header.length <= budget, `${handoff.header.length} > ${budget}`);
    assert.match(handoff.header, /<generated_handoff>\n## Primary Request/);
    // Directory previews skip the summary's headings.
    assert.match(handoff.header, /\nwin_001 \(start item_0\): g{20}/);
    assert.match(handoff.header, /\(p\/m\)/);
    assert.match(handoff.header, /Finish YAML/); assert.match(handoff.header, /User 3/);
    // Recent instructions are quoted up to 1,000 characters each, not a 200-character topic.
    assert.match(handoff.header, /\[item_\d+\] User 3: u{970}/);
  }
});

test('note capacity checks apply to write and append without evicting notes', () => {
  const notes = new NotesStore({ maxFiles: 2, maxTotalBytes: 10 });
  notes.appendToFile('self', 'a', 'abc'); notes.writeFile('self', 'b', 'def');
  assert.throws(() => notes.appendToFile('self', 'c', 'x'), /file limit/);
  assert.throws(() => notes.appendToFile('self', 'a', 'xxxxx'), /byte limit/);
  assert.equal(notes.readFile('self', 'a').content, 'abc');
});

const bodyOf = header => header.match(/<generated_handoff>\n([\s\S]*?)\n<\/generated_handoff>/)?.[1] ?? '';

test('an unused generated reserve returns to the handoff body, and notes cannot consume it', () => {
  const generated = { text: '## Body\n' + 'g'.repeat(60_000), provider: 'p', model: 'm' };

  // Sparse state: the snapshot allowance the record cannot spend is body content
  // now, instead of being stranded while the body is truncated.
  const lean = new WindowEngine(new SessionStateStore()).prepare(Session.create('sparse'), 16000, generated);
  assert.equal(lean.record.summary_kind, 'generated');
  assert.ok(lean.header.length <= 16000, `${lean.header.length} > 16000`);
  assert.ok(bodyOf(lean.header).length >= 12_000, `body ${bodyOf(lean.header).length} did not reclaim the reserve`);
  assert.match(lean.header, /\n<\/generated_handoff>/);

  // Oversized note previews stay bounded above the body baseline and never break
  // the body frame: the handoff is still usable and complete.
  const noted = Session.create('notes'), noteStates = new SessionStateStore();
  for (let i = 0; i < 8; i++) noteStates.writeNote(noted, `n${i}`, 'n'.repeat(9_000));
  const heavy = new WindowEngine(noteStates).prepare(noted, 16000, generated);
  assert.equal(heavy.record.summary_kind, 'generated');
  assert.ok(heavy.header.length <= 16000, `${heavy.header.length} > 16000`);
  assert.ok(bodyOf(heavy.header).length >= 5_000, `body ${bodyOf(heavy.header).length} was starved by notes`);
  assert.match(heavy.header, /Note self\/notes\/n/);
  assert.match(heavy.header, /\n<\/generated_handoff>/);
});

test('the quoted body allowance is the grant the very next clip applies', () => {
  const states = new SessionStateStore();
  const s = Session.create('allowance');
  for (let i = 0; i < 8; i++) user(s, `User ${i}: ` + 'u'.repeat(1_000));
  const engine = new WindowEngine(states);
  // A body with nothing to JSON-escape makes the window record exactly as long in
  // the probe as in the measured call, so this comparison is character-exact.
  const flat = { text: 'gggg'.repeat(15_000), provider: 'p', model: 'm' };
  const allowances = [];
  for (const budget of [8000, 16000, 32000]) {
    // Measuring lays out the same handoff the real call will, so the number the
    // summarizer is held to and the number the clip enforces are the same one.
    const allowance = engine.bodyAllowance(s, budget, flat);
    const body = bodyOf(engine.prepare(s, budget, flat).header);
    assert.ok(body.endsWith(TRUNCATION_MARKER));
    assert.equal(body.length - TRUNCATION_MARKER.length, allowance, `cap ${budget}`);
    allowances.push(allowance);
  }
  // The grant follows the cap instead of being pinned by a fixed reserve, which
  // is what the summarizer's ceiling is measured against.
  assert.ok(allowances[0] < allowances[1] && allowances[1] < allowances[2], allowances.join(', '));
  assert.ok(allowances[2] > 10_000, `largest allowance ${allowances[2]}`);
  // A realistic multi-line body diverges only by the record's JSON escaping of
  // the summary it clips — an order of magnitude below the margin the controller
  // keeps, and it errs towards a smaller grant, never a larger one.
  const lines = { text: Array.from({ length: 2_000 }, (_, i) => `- bullet ${i}`).join('\n'), provider: 'p', model: 'm' };
  const measured = engine.bodyAllowance(s, 16000, lines);
  const real = bodyOf(engine.prepare(s, 16000, lines).header).length - TRUNCATION_MARKER.length;
  assert.ok(real <= measured && measured - real < 200, `measured ${measured}, real ${real}`);
  // A cap that cannot carry a generated body reports no allowance rather than a
  // number the clip would not honour, and measuring commits nothing.
  assert.equal(engine.bodyAllowance(s, 100, flat), 0);
  assert.equal(states.get(s).windows.length, 1);
});

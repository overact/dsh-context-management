import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, user } from './helpers/dsh.js';
import { SessionStateStore } from '../lib/session-state.js';
import { WindowEngine } from '../lib/window-engine.js';
import { NotesStore } from '../lib/notes-store.js';

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
  assert.equal(engine.prepare(s, 7000, generated).record.summary_kind, 'extractive');
  for (const budget of [12000, 16000, 32000]) {
    const handoff = engine.prepare(s, budget, generated);
    assert.equal(handoff.record.summary_kind, 'generated');
    assert.ok(handoff.header.length <= budget, `${handoff.header.length} > ${budget}`);
    assert.match(handoff.header, /<generated_handoff>\n## Primary Request/);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, user, Context, SessionStore, Session, dsh } from './helpers/dsh.js';
import { SessionStateStore } from '../lib/session-state.js';
import { HistoryStore } from '../lib/history-store.js';
import { NoteRepository } from '../lib/note-repository.js';

test('real JSONL storage restores notes, windows and exact history through a fresh backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-context-test-'));
  const f = await fixture({ diskRoot: root });
  let second;
  try {
    const a = await f.agent('disk-session');
    user(a.session, 'Exact original output 中文\n' + 'x'.repeat(40_000)); user(a.session, 'Continue with YAML.');
    assert.equal((await f.execute(a, 'notes_write_file', { path: 'progress.md', text: '已完成实现\n' })).isError, false);
    assert.equal((await f.execute(a, 'notes_append_to_file', { path: 'progress.md', text: '待验证恢复。' })).isError, false);
    // Notes are plugin-owned Harness-home data, not files inside the persistence backend's layout.
    assert.ok(existsSync(join(root, 'context-management', 'notes', 'disk-session.json')));
    assert.ok(!readdirSync(root, { recursive: true }).some(p => String(p).endsWith('context-management-notes.json')));
    await f.native.compactNow(a, new AbortController().signal);
    // A fresh request interrupted before its next step must not run during resume.
    await f.execute(a, 'new_context');
    await f.dispose();
    second = new Context(); new SessionStore(second);
    const storageModule = await dsh('dsh-session-persistence-jsonl');
    const JsonlSessionPersistence = storageModule.JsonlSessionPersistence ?? storageModule.default;
    const storage = new JsonlSessionPersistence(second, { root, compression: 'none' });
    let persisted;
    if (typeof storage.open === 'function') {
      const handle = await storage.open('disk-session', 'read');
      try { persisted = { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read()).events }; }
      finally { await handle.close(); }
    } else persisted = await storage.inspect('disk-session');
    const s = Session.fromRestore('disk-session', persisted.events, persisted.meta, persisted.inheritedEventCount);
    const states = new SessionStateStore(new NoteRepository(() => join(root, 'context-management', 'notes'))); const state = states.get(s);
    assert.equal(state.windows.at(-1).window_id, 'win_002');
    assert.equal(state.pending, null);
    assert.equal(state.notes.readFile('self', 'progress.md').content, '已完成实现\n待验证恢复。');
    assert.match(new HistoryStore(s, states).readItem({ item_id: 'item_0' }).content, /Exact original output 中文/);
  } finally {
    if (second) await second.fiber.dispose();
    await f.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

test('failed durability is reported rather than acknowledging a saved note', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent();
  f.ctx.on('session/flush', () => { throw new Error('disk unavailable'); });
  const write = await f.execute(a, 'notes_write_file', { path: 'progress.md', text: 'state' });
  assert.equal(write.isError, true);
  assert.match(JSON.stringify(write), /disk unavailable/);
  assert.equal(f.plugin.states.get(a.session).windows.length, 1);
  assert.equal((await f.execute(a, 'new_context')).isError, true);
  assert.equal(f.plugin.states.get(a.session).pending, null);
});

test('concurrent note writers serialize without lost appends', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent();
  const left = new SessionStateStore(new NoteRepository(f.notesRoot));
  const right = new SessionStateStore(new NoteRepository(f.notesRoot));
  await Promise.all([
    left.writeNote(a.session, 'progress.md', 'LEFT\n', 'append'),
    right.writeNote(a.session, 'progress.md', 'RIGHT\n', 'append'),
  ]);
  const restored = new NoteRepository(f.notesRoot).load(a.session).readFile('self', 'progress.md').content;
  assert.match(restored, /LEFT/); assert.match(restored, /RIGHT/);
});

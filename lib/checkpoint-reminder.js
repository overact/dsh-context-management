/** Advisory checkpoint reminder text. DSH's native engine owns actual pressure
 * cuts and provider-confirmed overflow recovery; this does not meter tokens.
 */
export function checkpointReminder(remainingTokens) {
  return `<context_window_reminder>
Approximately ${remainingTokens} tokens remain before DSH's automatic compaction threshold (not the model's physical context limit).
Save one concise checkpoint with notes_write_file: current task, later user corrections, completed work, unresolved work, and relevant history item IDs when needed. Prefer replacing checkpoint.md to accumulating large append-only notes.
Once saved, call new_context if ready. Rotation occurs after this step's tool results are recorded; a recent balanced conversation tail remains visible. Continue the task after rotation.
</context_window_reminder>`;
}

/** Advisory checkpoint reminder. DSH's native engine owns actual pressure cuts
 * and provider-confirmed overflow recovery; this guard does not invent a token meter.
 */
export const DEFAULT_REMINDER_THRESHOLD_TOKENS = 6144;
export class TokenBudgetGuard {
  evaluate(remainingTokens, reminderThreshold = DEFAULT_REMINDER_THRESHOLD_TOKENS) {
    if (!Number.isFinite(remainingTokens)) return 'ok';
    if (remainingTokens <= 0) return 'compact';
    return remainingTokens <= reminderThreshold ? 'reminder' : 'ok';
  }

  formatReminder(remainingTokens) {
    return `<context_window_reminder>
Approximately ${remainingTokens} tokens remain before DSH's automatic compaction threshold (not the model's physical context limit).
Save one concise checkpoint with notes_write_file: current task, later user corrections, completed work, unresolved work, and relevant history item IDs when needed. Prefer replacing checkpoint.md to accumulating large append-only notes.
Once saved, call new_context if ready. Rotation occurs after this step's tool results are recorded; a recent balanced conversation tail remains visible. Continue the task after rotation.
</context_window_reminder>`;
  }
}

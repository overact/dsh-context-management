/** Plain text of message content: text blocks only (tool payloads excluded). */
export function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

/** Marks bounded text as an excerpt, never a claim of complete semantic recall. */
export const TRUNCATION_MARKER = '… [truncated]';

/** Bounded text is an excerpt, never a claim of complete semantic recall. Never
 * cuts between a surrogate pair: half of one is not a character. */
export function clip(text, budget) {
  text = String(text ?? '');
  if (text.length <= budget) return text;
  let end = Math.max(0, budget - TRUNCATION_MARKER.length - 2);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + TRUNCATION_MARKER;
}

/** An optional integer argument: `fallback` when absent, capped at `max`. */
export function boundedInt(value, fallback, max, min = 0) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Expected an integer >= ${min}.`);
  return Math.min(value, max);
}

/** One character page of `content` with the cursor fields the read tools return. */
export function page(content, offset, limit) {
  const text = content.slice(offset, offset + limit);
  const more = offset + text.length < content.length;
  return { content: text, offset_chars: offset, total_chars: content.length,
    has_more: more, next_offset_chars: more ? offset + text.length : null };
}

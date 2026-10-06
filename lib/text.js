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

/** Plain text of message content: text blocks only (tool payloads excluded). */
export function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

/** Marks bounded text as an excerpt, never a claim of complete semantic recall. */
export const TRUNCATION_MARKER = '… [truncated]';

/** Bounded text is an excerpt, never a claim of complete semantic recall. */
export function clip(text, budget) {
  text = String(text ?? '');
  return text.length <= budget ? text : text.slice(0, Math.max(0, budget - TRUNCATION_MARKER.length - 2)) + TRUNCATION_MARKER;
}

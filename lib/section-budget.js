import { clip, TRUNCATION_MARKER } from './text.js';

/** The host's compaction directive mandates these eight sections, in this order,
 * and writes `## Critical Context` last — so a plain tail cut deletes decisions,
 * constraints and open questions before anything else. These weights are a
 * PREFERENCE, not a guarantee: every piece first keeps a marker reservation, then
 * a small floor so it keeps some text of its own, and only then is the rest split
 * by weight. A floor is a share of the budget, not a promise that a whole bullet or
 * a complete path survives inside it. `Files and Code` carries the long excerpts, so it
 * gives ground first; `Pending Jobs` outranks the error log because unfinished
 * requested work is the easiest thing to lose and the hardest to reconstruct.
 */
const CANONICAL_WEIGHTS = new Map([
  ['critical context', 400],
  ['next step', 200],
  ['pending jobs', 120],
  ['current work', 80],
  ['primary request and intent', 40],
  ['key technical concepts', 30],
  ['errors and fixes', 30],
  ['files and code', 10],
]);

/** Text before the first heading is one more piece, at a low priority, so a long
 * preamble cannot be kept whole while the mandated sections starve. */
const LEAD_WEIGHT = 15;

/** Every unrecognized heading together shares one weight and one floor, so a reply
 * with twenty ad-hoc headings cannot outvote or outspend the mandated structure.
 * Their heading lines still cost budget; nothing here promises immunity to an
 * arbitrarily large number of headings. */
const UNKNOWN_WEIGHT_POOL = 50;

/** Share of the budget each piece is offered above its marker reservation, so a
 * piece keeps some of its own text rather than only a marker. It is not a promise
 * about what that text contains: a floor can hold a partial path or a truncated
 * bullet. A duplicate canonical heading and every unknown heading share their
 * group's floor. */
const MIN_SECTION_CONTENT = 160;

/** Named in a clipping receipt before the rest is reported as a count. */
const RECEIPT_SECTIONS = 3;

/** Longest piece name a receipt will print, in characters. */
const RECEIPT_NAME_MAX = 40;

/** CommonMark fenced code block: at most three spaces of indent, then a run of
 * backticks or tildes. A backtick fence's info string may not contain a backtick,
 * and only the same character, at least as long, closes it. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const fenceOpens = fence => !(fence[1][0] === '`' && fence[2].includes('`'));
const isCloser = (fence, open) =>
  fence[1][0] === open.char && fence[1].length >= open.length && fence[2].trim() === '';

/** A dropped piece keeps the marker and the newline that puts it on its own line. */
const MARKER_ROOM = TRUNCATION_MARKER.length + 1;

/** A line boundary is only worth taking while it wastes less than this much of a
 * piece's room; a single oversized bullet is better cut mid-line. */
const LINE_BOUNDARY_KEEP = 0.75;

/** Never end a clip inside a surrogate pair, which would emit a broken character. */
function safeEnd(text, end) {
  if (end <= 0) return 0;
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** Bounded text that never exceeds `budget`, not even below the marker's length. */
const bounded = (text, budget) => budget < TRUNCATION_MARKER.length
  ? text.slice(0, safeEnd(text, Math.max(0, budget)))
  : clip(text, budget);

/** The fence delimiter `text` ends inside, or `null`. This reads the exact text
 * being kept — including a delimiter line a cut truncated, which a markdown parser
 * still reads as an opener — because a fence left open turns every following
 * heading into code and costs the next compaction the sections after it.
 */
function openFence(text) {
  let open = null, at = -1, offset = 0;
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line);
    if (fence !== null) {
      if (open === null) {
        if (fenceOpens(fence)) { open = fence[1]; at = offset; }
      } else if (isCloser(fence, { char: open[0], length: open.length })) { open = null; at = -1; }
    }
    offset += line.length + 1;
  }
  return open === null ? null : { delimiter: open, at };
}

/** Text that keeps its fences balanced inside `room`, and how much of the original
 * `text` it kept. A block the cut left open is closed when the delimiter fits, and
 * retreated out of when it does not.
 */
function closeFences(text, room) {
  let kept = text, source = text.length;
  for (let guard = 0; guard < 4; guard++) {
    const open = openFence(kept);
    if (open === null) return { text: kept, source };
    if (kept.length + 1 + open.delimiter.length <= room) return { text: `${kept}\n${open.delimiter}`, source };
    kept = kept.slice(0, open.at);
    source = open.at;
  }
  return openFence(kept) === null ? { text: kept, source } : { text: '', source: 0 };
}

/** Clip one piece's content: always a marker on its own line, never a fence left
 * open, a bullet boundary where one is cheap, never a split surrogate pair.
 * @returns `{ text, retained }` — the rendered text, and how much of `content`
 * survived it, which is what a receipt reports.
 */
function clipContent(content, grant) {
  if (content.length <= grant) {
    // Nothing is dropped, but a fence the model never closed is repaired while the
    // delimiter still fits, so the next parse cannot read the rest as code.
    return { text: closeFences(content, grant).text, retained: content.length };
  }
  // Unreachable for an admitted layout: every piece reserves MARKER_ROOM first.
  if (grant < MARKER_ROOM) return { text: '', retained: 0 };
  const room = grant - MARKER_ROOM;
  if (room <= 0) return { text: TRUNCATION_MARKER, retained: 0 };
  let end = Math.min(room, content.length);
  const cut = content.lastIndexOf('\n', end);
  if (cut >= 0 && cut + 1 >= end * LINE_BOUNDARY_KEEP) end = cut + 1;
  end = safeEnd(content, end);
  const closed = closeFences(content.slice(0, end), room);
  const kept = closed.text.replace(/\n+$/, '');
  if (kept === '') return { text: TRUNCATION_MARKER, retained: 0 };
  return { text: `${kept}\n${TRUNCATION_MARKER}`, retained: closed.source };
}

/** Split into the preamble and one piece per ATX heading, skipping fenced code.
 * Pieces concatenate back to `text` byte for byte.
 */
function splitSections(text) {
  const lines = text.split('\n');
  const offsets = [];
  let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }
  const headings = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]);
    if (open !== null) {
      if (fence !== null && isCloser(fence, { char: open[0], length: open.length })) open = null;
      continue;
    }
    if (fence !== null) {
      if (fenceOpens(fence)) open = fence[1];
      continue;
    }
    if (/^ {0,3}## /.test(lines[i])) headings.push(i);
  }
  if (headings.length < 2) return null;
  const pieces = headings.map((line, k) => {
    const heading = lines[line];
    const start = offsets[line];
    const end = k + 1 < headings.length ? offsets[headings[k + 1]] : text.length;
    const raw = text.slice(start + heading.length + 1, end);
    const sep = raw.endsWith('\n') ? '\n' : '';
    // Trailing ATX closing hashes carry no content.
    const title = heading.replace(/^ {0,3}## ?/, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
    return { name: title, heading, content: sep ? raw.slice(0, -1) : raw, sep };
  });
  const head = text.slice(0, offsets[headings[0]]);
  if (head !== '') pieces.unshift({ name: 'lead', heading: '', content: head.replace(/\n$/, ''), sep: '\n', lead: true });
  return pieces;
}

/** One entitlement per canonical section, one for the preamble, and one shared by
 * every unrecognized heading: a duplicated `## Critical Context` shares its weight
 * and its floor instead of voting twice.
 */
function groupKey(piece) {
  if (piece.lead === true) return 'lead';
  const key = piece.name.toLowerCase();
  return CANONICAL_WEIGHTS.has(key) ? key : 'unknown';
}

function entitlements(pieces) {
  const counts = new Map();
  for (const piece of pieces) {
    const key = groupKey(piece);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return pieces.map(piece => {
    const key = groupKey(piece);
    const size = counts.get(key);
    return {
      weight: key === 'lead' ? LEAD_WEIGHT
        : key === 'unknown' ? UNKNOWN_WEIGHT_POOL / size
          : CANONICAL_WEIGHTS.get(key) / size,
      floor: MIN_SECTION_CONTENT / size,
    };
  });
}

/** Marker reservations, then floors in weight order, then a capped weighted fill
 * of what is left. Never returns more than `budget`, and never less than a piece's
 * reservation — the caller admits the layout only when every reservation fits, so
 * no piece can be emptied without a marker.
 */
function allocate(lengths, entitlementsList, budget) {
  const grants = lengths.map(length => Math.min(length, MARKER_ROOM));
  let remaining = budget - grants.reduce((sum, grant) => sum + grant, 0);
  if (remaining <= 0) return grants;
  const order = lengths.map((_, i) => i).sort((a, b) => entitlementsList[b].weight - entitlementsList[a].weight);
  for (const i of order) {
    if (remaining <= 0) break;
    const want = Math.min(lengths[i], Math.max(entitlementsList[i].floor, grants[i])) - grants[i];
    const give = Math.min(want, remaining);
    grants[i] += give;
    remaining -= give;
  }
  const weights = entitlementsList.map(entry => entry.weight);
  const room = i => lengths[i] - grants[i];
  const active = new Set(lengths.map((_, i) => i).filter(i => room(i) > 0));
  while (active.size > 0 && remaining > 0) {
    const total = [...active].reduce((sum, i) => sum + weights[i], 0);
    if (total <= 0) break;
    const fits = [];
    for (const i of active) if (remaining * weights[i] / total >= room(i)) fits.push(i);
    if (fits.length === 0) {
      let spent = 0;
      for (const i of active) { const add = Math.floor(remaining * weights[i] / total); grants[i] += add; spent += add; }
      // Flooring must never strand the last characters: the piece that is first in
      // the entitlement order still waiting takes them.
      const best = [...active].sort((a, b) => weights[b] - weights[a])[0];
      grants[best] += remaining - spent;
      return grants.map((grant, i) => Math.min(grant, lengths[i]));
    }
    for (const i of fits) { remaining -= room(i); grants[i] = lengths[i]; active.delete(i); }
  }
  return grants;
}

/**
 * Lay a generated handoff out inside `budget`. A body with fewer than two `## `
 * sections (an extractive body, a budget probe, a reply that ignored the mandated
 * structure) is clipped from the end exactly as before; a sectioned body spends
 * its budget by priority instead of losing its last section to the cut.
 * @returns `{ text, keptSource, totalSource, sectioned, fallback, pieces }`, where
 * `pieces` reports per-piece retained source characters for a clipping receipt.
 */
export function planHandoff(text, budget) {
  text = String(text ?? '');
  const totalSource = text.length;
  const plain = fallback => {
    // A fallback clip still must not leave a fence open: one open fence turns every
    // following heading into code, which is the failure this whole layout exists to
    // prevent. The closer is appended only while it fits the budget.
    const closed = closeFences(bounded(text, budget), budget);
    return { text: closed.text, keptSource: closed.source, totalSource, sectioned: false, fallback, pieces: [] };
  };
  if (totalSource <= budget) {
    // Nothing is dropped, but the fast path must not hand on a fence the model
    // never closed either: one open fence turns every following heading into code.
    const closed = closeFences(text, budget);
    return { text: closed.text, keptSource: closed.source, totalSource, sectioned: false, fallback: null, pieces: [] };
  }
  const pieces = splitSections(text);
  if (pieces === null) return plain('sections');
  const overhead = pieces.reduce((sum, piece) => sum + piece.heading.length + 1 + piece.sep.length, 0);
  // Admitted only when every piece can afford its heading and at least a marker of
  // its own; otherwise the plain prefix clip is the honest layout.
  const reservations = pieces.reduce((sum, piece) => sum + Math.min(piece.content.length, MARKER_ROOM), 0);
  if (overhead + reservations > budget) return plain('structure');
  const grants = allocate(pieces.map(piece => piece.content.length), entitlements(pieces), budget - overhead);
  const rendered = pieces.map((piece, i) => ({ piece, ...clipContent(piece.content, grants[i]) }));
  const out = rendered
    .map(({ piece, text: clipped }) => `${piece.heading}${piece.heading === '' ? '' : '\n'}${clipped}${piece.sep}`)
    .join('');
  // Unreachable while the reservations above hold; kept as a hard guarantee.
  if (out.length > budget) return plain('structure');
  const keptSource = rendered.reduce((sum, item) => sum + item.retained, 0);
  return {
    text: out, keptSource, totalSource, sectioned: true, fallback: null,
    pieces: rendered.map(({ piece, retained }) => ({
      name: piece.name, lead: piece.lead === true, kept: retained,
      original: piece.content.length, shortened: retained < piece.content.length,
    })),
  };
}

/** The clipped handoff text only. */
export const clipSections = (text, budget) => planHandoff(text, budget).text;

/** Reserved for the clipping receipt when the reply has to be clipped, as a
 * constant rather than the receipt's own length: the space the body gets must not
 * depend on the reply it reports on. Nothing is reserved when the reply already fits.
 */
export const RECEIPT_RESERVE = 320;

/** One mechanically generated line stating what this clip dropped and where the
 * untrimmed reply can be read. A marker written by the summarizer is not durable
 * evidence of incompleteness; this is, and it survives into the next checkpoint.
 * It describes CLIPPING only — it cannot certify that the summarizer omitted
 * nothing — and it never claims that unlisted pieces are semantically complete.
 * Rendered to fit `limit`, losing detail before correctness.
 */
export function clippingReceipt(plan, limit = RECEIPT_RESERVE) {
  const open = '<clipping_receipt>', close = '</clipping_receipt>';
  const recovery = ' Raw reply: this window\'s summary item, history_read_item format:"json".';
  const kept = `${plan.keptSource} of ${plan.totalSource} source characters kept`;
  // A model writes the headings, so its text must not be able to close the envelope.
  const name = piece => (piece.lead ? 'lead'
    : String(piece.name).replace(/[<>&\u0000-\u001f]/g, '').slice(0, RECEIPT_NAME_MAX));
  const forms = [];
  if (plan.fallback !== null && plan.fallback !== undefined) {
    const why = plan.fallback === 'sections'
      ? 'fewer than two "## " sections were recognised'
      : 'the sectioned layout did not fit the budget';
    forms.push(`Clipped from the end: ${kept}; ${why}.`);
  } else if (plan.sectioned !== true) {
    forms.push(`Not shortened by this clip: ${kept}.`);
  } else {
    const shortened = plan.pieces.filter(piece => piece.shortened);
    if (shortened.length === 0) forms.push(`Not shortened by this clip: ${kept}.`);
    else {
      for (const count of [RECEIPT_SECTIONS, 2, 1]) {
        if (count > shortened.length) continue;
        const listed = shortened.slice(0, count)
          .map(piece => `${name(piece)} ${piece.kept}/${piece.original}`).join(', ');
        const rest = shortened.length > count ? `, +${shortened.length - count} more` : '';
        forms.push(`Clipped by priority: ${kept}. Shortened: ${listed}${rest}.`);
      }
      forms.push(`Clipped by priority: ${kept}; ${shortened.length} of ${plan.pieces.length} pieces shortened.`);
    }
  }
  for (const form of forms) {
    const text = `${open}${form}${recovery}${close}`;
    if (text.length <= limit) return text;
  }
  const shortest = `${open}${kept}.${close}`;
  return shortest.length <= limit ? shortest : '';
}

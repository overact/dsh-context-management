import { TEMPLATE_PROVIDER, TEMPLATE_MODEL } from './session-state.js';
import { textContent } from './text.js';
import { WindowEngine } from './window-engine.js';
import { strategyFor } from './window-policy.js';
import { createUserMessage, IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm';

/** A body allowance below this is degenerate; advising it would be noise. */
const MIN_HINT_ALLOWANCE = 2000;
/** Sections the host's compaction directive mandates, for the per-section budget. */
const HINT_SECTIONS = 8;

/** The host directive mandates the section order, so `## Critical Context` is
 * written last: an unguided overrun is truncated exactly where decisions,
 * constraints and open questions live. The hint therefore carries a measured
 * character ceiling, a countable per-section budget, and the order in which to
 * give ground, because a model cannot measure the length of its own reply.
 */
function lengthHint(surviving) {
  const perSection = Math.floor(surviving / HINT_SECTIONS / 100) * 100;
  return [
    `Compaction budget: only the first ~${surviving} characters of your reply are kept. Everything after that is cut off mid-sentence and lost, and what is lost is whatever you wrote last.`,
    `The eight sections are mandatory and stay in the order given, so a long middle section is what pushes the end off the page: keep the middle ones tight. Budget roughly ${perSection} characters per section, prefer several one-line bullets over a few long ones, and never drop or merge a section.`,
    'Spend the budget in this order: (1) Critical Context, Next Step and Current Work must stay complete and specific; (2) Primary Request and Intent, Key Technical Concepts and Errors and Fixes stay terse; (3) give up long file and code excerpts, repeated path lists, restated background, and implementation detail first. If you run out of room, cut detail rather than sections, and cut from Files and Code before anything else.',
  ].join('\n');
}

/** Windowing policy for one compaction engine. The engine keeps DSH's native
 * maintenance admission, balanced cuts, shrink check, durable transaction and
 * overflow retry policy; `native` exposes its un-overridden hooks and config.
 */
export class WindowController {
  /**
   * @param ctx - the engine's context (logger).
   * @param native - `{ summarize, compactIfNeeded, config }` bound to the base engine.
   * @param host - the `contextWindows` service published by the host plugin.
   */
  constructor(ctx, native, host) {
    this.ctx = ctx;
    this.native = native;
    this.states = host.states;
    this.getConfig = host.getConfig;
    this.windows = new WindowEngine(this.states);
    this.forced = new WeakSet();
  }

  active(agent) {
    const config = this.getConfig();
    return config.enabled && config.injectTools && config.overrideCompaction && strategyFor(agent, config) === 'window';
  }

  async summarize(input, agent, signal) {
    if (!this.active(agent) && !this.forced.has(agent.session)) return this.native.summarize(input, agent, signal);
    signal?.throwIfAborted();
    const config = this.getConfig();
    const generated = config.handoffSummary === 'generated' ? await this.generateHandoff(input, agent, signal, config) : null;
    const rotation = this.windows.prepare(agent.session, config.handoffMaxChars, generated && {
      text: textContent(generated.summary), provider: generated.provider, model: generated.model });
    const summary = [{ type: 'text', text: rotation.header }];
    // A call that succeeded keeps its real envelope even when the body was dropped
    // for budget: the summarizer ran, so cost accounting must see the actual
    // provider, model, raw output and usage instead of the template pair. The
    // window record states why the body became extractive.
    return generated
      ? { ...generated, summary }
      : { summary, provider: TEMPLATE_PROVIDER, model: TEMPLATE_MODEL };
  }

  async compactIfNeeded(agent, trigger, signal) {
    const config = this.getConfig();
    if (config.enabled && config.injectTools && this.states.get(agent.session).pending) {
      return this.rotatePending(agent, signal);
    }
    return this.native.compactIfNeeded(agent, trigger, signal);
  }

  /** One native LLM summary of the outgoing region, the body of the handoff.
   * A failed auxiliary call degrades to the extractive handoff instead of blocking rotation.
   */
  async generateHandoff(input, agent, signal, config) {
    try {
      return await this.native.summarize(this.withLengthHint(input, agent, config), agent, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // The base engine runs its `compaction/summary-error` recovery around this
      // call (image offload and any other host handler). Swallowing a recoverable
      // failure here would skip that recovery and force an avoidable extractive
      // handoff, so hand it back to the host instead of degrading locally.
      if (error?.code === IMAGE_OFFLOAD_REQUIRED_CODE) throw error;
      this.ctx.logger?.warn?.('context-management: generated handoff failed; using extractive handoff', error);
      return null;
    }
  }

  /** Append the measured character ceiling to the summarizer's own input. The
   * host delivers its directive as the FINAL user message after the replayed
   * conversation, so a hint added here lands immediately before it: the replayed
   * prefix, and the provider's prefix cache, are untouched. The hint is prompt
   * scaffolding only — it never reaches the session or the checkpoint.
   */
  withLengthHint(input, agent, config) {
    if (!Array.isArray(input?.messages)) return input;
    let allowance;
    try {
      allowance = this.windows.bodyAllowance(agent.session, config.handoffMaxChars);
    } catch (error) {
      // The nudge is advisory and runs inside the caller's degrade-to-extractive
      // path: failing to measure it must never cost the generated handoff.
      this.ctx.logger?.warn?.('context-management: could not measure the handoff budget; sending the request without a budget note', error);
      return input;
    }
    // Quote a round number at or below the real grant. The provenance line is
    // written with the provider and model the call only reports afterwards, so
    // the measurement can carry a few characters of slack; a full rounding unit
    // of margin keeps the promise the clip has to honour.
    const surviving = Math.floor((allowance - 100) / 100) * 100;
    if (surviving < MIN_HINT_ALLOWANCE) return input;
    return {
      ...input,
      messages: [...input.messages, createUserMessage({
        content: [{ type: 'text', text: lengthHint(surviving) }],
        source: { kind: 'plugin:context-management' },
      })],
    };
  }

  /** Process a model request only after its tool result and sibling results have
   * reached the log. Native overflow selection preserves a balanced recent tail.
   */
  async rotatePending(agent, signal) {
    const session = agent.session;
    const request = this.states.get(session).pending;
    if (!request) return null;
    if (strategyFor(agent, this.getConfig()) !== 'window') {
      this.finishPending(session, request.seq, 'The current model policy uses native compaction; no window rotation was performed.');
      return null;
    }
    this.forced.add(session);
    try {
      const result = await this.native.compactIfNeeded(agent, 'context-overflow', signal);
      this.states.get(session); // Fold the committed rotation before reporting.
      if (result === null) this.finishPending(session, request.seq, 'No safely reducible history yet; the current window is unchanged.');
      return result;
    } catch (error) {
      this.finishPending(session, request.seq, 'Window rotation did not complete: ' + String(error.message ?? error).slice(0, 300), !signal?.aborted);
      if (signal?.aborted) throw error;
      this.ctx.logger?.warn?.('context-management: requested rotation failed', error);
      return null;
    } finally {
      this.forced.delete(session);
    }
  }

  finishPending(session, seq, reason, visible = true) {
    this.states.finishRequest(session, seq);
    if (visible) session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: reason }],
      source: { kind: 'plugin:context-management' },
    }), { surfaceOp: 'append' });
  }
}

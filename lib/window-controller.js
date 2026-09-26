import { TEMPLATE_PROVIDER, TEMPLATE_MODEL } from './session-state.js';
import { textContent } from './text.js';
import { WindowEngine } from './window-engine.js';
import { strategyFor } from './window-policy.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

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
    const generated = config.handoffSummary === 'generated' ? await this.generateHandoff(input, agent, signal) : null;
    const rotation = this.windows.prepare(agent.session, config.handoffMaxChars, generated && {
      text: textContent(generated.summary), provider: generated.provider, model: generated.model });
    const summary = [{ type: 'text', text: rotation.header }];
    // Keep the auxiliary call's provider, model, usage and raw output on the durable
    // compaction/summary event so cost accounting sees the real summarizer call.
    return rotation.record.summary_kind === 'generated'
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
  async generateHandoff(input, agent, signal) {
    try {
      return await this.native.summarize(input, agent, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.ctx.logger?.warn?.('context-management: generated handoff failed; using extractive handoff', error);
      return null;
    }
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

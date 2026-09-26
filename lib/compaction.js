import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { WindowController } from './window-controller.js';

/** Preset compaction row: `@local/dsh-context-management/compaction` in place of
 * `@deepseek-ai/dsh-compaction-basic`, with the same config.
 *
 * Uses DSH's supported subclass seam: `summarize()` is the customization hook and
 * `compactIfNeeded()` is dynamically dispatched by the automatic listeners. The
 * host plugin's `contextWindows` service is looked up per call rather than
 * injected, so without the host this engine behaves exactly like the native one
 * instead of leaving the preset without compaction.
 */
export class WindowingCompactionEngine extends BasicCompactionEngine {
  // Plain fields: Cordis serves this instance through a Proxy, and private
  // `#fields` throw when read through one.
  windowController = null;
  windowStates = null;

  constructor(ctx, config) {
    super(ctx, config);
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const host = this.host();
      if (host) {
        // Tells new_context this agent's preset can actually rotate windows.
        host.serve(agent.session);
        // With auto:true the native pressure listener already dispatches to
        // compactIfNeeded; with auto:false explicit requests still rotate here.
        const config = host.getConfig();
        if (!this.config.auto && config.enabled && config.injectTools && host.states.get(agent.session).pending) {
          await this.controller().rotatePending(agent, signal);
        }
      }
      return next();
    });
  }

  host() {
    return this.ctx.get('contextWindows') ?? null;
  }

  /** One controller per live host state store (stable even if the service value is
   * re-wrapped on lookup); a reloaded host gets a fresh one. */
  controller() {
    const host = this.host();
    if (!host) return null;
    if (this.windowStates !== host.states) {
      this.windowStates = host.states;
      this.windowController = new WindowController(this.ctx, {
        summarize: (input, agent, signal) => this.nativeSummarize(input, agent, signal),
        compactIfNeeded: (agent, trigger, signal) => super.compactIfNeeded(agent, trigger, signal),
        config: this.config,
      }, host);
    }
    return this.windowController;
  }

  /** The base LLM summarizer; a separate method so tests can substitute a fixture. */
  nativeSummarize(input, agent, signal) {
    return super.summarize(input, agent, signal);
  }

  summarize(input, agent, signal) {
    const controller = this.controller();
    return controller ? controller.summarize(input, agent, signal) : this.nativeSummarize(input, agent, signal);
  }

  compactIfNeeded(agent, trigger, signal) {
    const controller = this.controller();
    return controller ? controller.compactIfNeeded(agent, trigger, signal) : super.compactIfNeeded(agent, trigger, signal);
  }
}

export default WindowingCompactionEngine;

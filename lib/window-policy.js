/** Explicit policy; never infer model capability from a provider/model name. */
export function strategyFor(agent, config) {
  const target = agent.session.requestHeader()?.config ?? agent.options ?? {};
  return config.modelPolicies?.find(p => p.provider === target.provider && p.model === target.model)?.strategy
    ?? config.defaultStrategy ?? 'window';
}

/** Context management is on and its tools are mounted: windows, notes and history are live. */
export function toolsEnabled(config) {
  return Boolean(config.enabled && config.injectTools);
}

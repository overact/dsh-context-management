/** Explicit policy; never infer model capability from a provider/model name. */
export function strategyFor(agent, config) {
  const target = agent.session.requestHeader()?.config ?? agent.options ?? {};
  return config.modelPolicies?.find(p => p.provider === target.provider && p.model === target.model)?.strategy
    ?? config.defaultStrategy ?? 'window';
}

/** DSH 0.1.7 pressure contract. Keep parity covered against the installed engine. */
export function pressureThreshold(nativeConfig, request, modelInfo) {
  const capacity = modelInfo.context?.contextWindow;
  const override = nativeConfig.modelPolicies.find(p => p.provider === request.provider && p.model === request.model);
  const ratio = override?.thresholdRatio ?? nativeConfig.thresholdRatio;
  const headroom = override?.headroomTokens ?? nativeConfig.headroomTokens;
  const output = request.maxTokens ?? modelInfo.defaultMaxTokens ?? 0;
  if (!Number.isInteger(capacity) || capacity <= 0 || !Number.isInteger(output) || output < 0
      || !Number.isInteger(headroom) || headroom < 0 || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return null;
  const threshold = Math.floor(Math.min(capacity * ratio, capacity - output - headroom));
  return threshold > 0 ? threshold : null; // Native engine owns invalid-policy diagnostics.
}

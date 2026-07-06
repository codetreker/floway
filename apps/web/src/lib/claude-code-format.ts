// `subscriptionType` and `rateLimitTier` are independent fields per the
// upstream CLI: plan name vs. usage-multiplier tier.

export const formatClaudeCodeSubscriptionType = (
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null | undefined,
  rateLimitTier: string | null | undefined,
): string | null => {
  if (!subscriptionType) return null;
  const base = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' }[subscriptionType];
  if (subscriptionType !== 'max') return base;
  const suffix = rateLimitTier
    ? ({ default_claude_max_5x: '5×', default_claude_max_20x: '20×' } as Record<string, string>)[rateLimitTier]
    : undefined;
  return suffix ? `${base} ${suffix}` : base;
};

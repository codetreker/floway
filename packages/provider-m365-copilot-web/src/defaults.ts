import type { FlagDefaults } from '@floway-dev/provider';

export const M365_COPILOT_WEB_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'anthropic-messages-web-search-shim': false,
  'openai-responses-web-search-shim': false,
  'openai-responses-image-generation-shim': false,
  'openai-responses-compact-shim': true,
  'disable-reasoning-on-forced-tool-choice': false,
  'rewrite-mid-conv-system-to-user': false,
  'rewrite-developer-to-system': false,
  'rewrite-system-to-developer': false,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
  'usage-exclusive-cached-tokens': false,
};

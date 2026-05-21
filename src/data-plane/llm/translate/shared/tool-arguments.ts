/**
 * Degenerate Copilot tool-call streams have been observed to emit nothing but
 * line breaks / tabs until `max_tokens`, which keeps the client hanging while
 * never producing valid JSON arguments.
 *
 * The same guard exists in `caozhiyuan/copilot-api`:
 * - https://github.com/caozhiyuan/copilot-api/commit/4c0d775e1dc6b8648c7ad5f21fb783fc3246facf
 * - https://github.com/caozhiyuan/copilot-api/commit/3cdc32c0811469da9eebec5ca3892caf068df542
 * We keep the shared threshold here because both Chat Completions->Messages
 * and Responses->Messages stream translators need the same cutoff.
 */
const MAX_CONSECUTIVE_WHITESPACE = 20;

export const parseToolArgumentsObject = (argumentsJson: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(argumentsJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : { raw_arguments: argumentsJson };
  } catch {
    return { raw_arguments: argumentsJson };
  }
};

export function checkWhitespaceOverflow(text: string, currentCount: number): { count: number; exceeded: boolean } {
  let wsCount = currentCount;
  for (const ch of text) {
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      wsCount++;
      if (wsCount > MAX_CONSECUTIVE_WHITESPACE) {
        return { count: wsCount, exceeded: true };
      }
    } else if (ch !== ' ') {
      wsCount = 0;
    }
  }
  return { count: wsCount, exceeded: false };
}

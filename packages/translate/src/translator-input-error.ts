// A caller-input validation failure surfaced by a translator: the caller
// sent something the target protocol cannot represent (an unsupported
// content-part type, a role the target does not accept, a missing field
// the target requires, etc.). Distinct from a plain `Error` so the
// data-plane http handlers can return a protocol-shaped 400 envelope
// instead of routing the failure through the generic internal-error 502
// path. The optional `param` follows the OpenAI / Anthropic error-body
// convention for naming the offending caller-visible field.
export class TranslatorInputError extends Error {
  readonly param: string | undefined;

  constructor(message: string, options?: { param?: string }) {
    super(message);
    this.name = 'TranslatorInputError';
    this.param = options?.param;
  }
}

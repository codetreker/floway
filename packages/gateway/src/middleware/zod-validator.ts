import { zValidator as zValidatorBase } from '@hono/zod-validator';
import type { Context, ValidationTargets } from 'hono';
import type { z, ZodType } from 'zod';

import type { AuthVars } from './auth.ts';

// Wrap @hono/zod-validator so validation failures return our canonical
// `{ error: msg }` 400 shape — matching what the hand-written control-plane
// validators returned before this change. Without the wrapper, zValidator's
// default response includes the full ZodError tree, which is too noisy for the
// dashboard's inline error UI and would force the SPA to learn a second error
// format.
export const zValidator = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidatorBase(target, schema, (result, c) => {
    if (!result.success) {
      // Take the first issue's message verbatim. Schemas attach field-aware
      // messages (e.g. "version must be 2") where they want to override
      // zod's default phrasing, so we don't prepend the path — that would
      // double up the field name in custom-message cases.
      const issue = result.error.issues[0];
      return c.json({ error: issue?.message ?? 'Invalid input' }, 400);
    }
  });

// Handler context aliases for routes whose request shape is declared via
// zValidator middleware. Handlers in separate files import these to type
// `c.req.valid('json' | 'query')` precisely without restating the env / path
// generics every time. The Variables generic mirrors app.ts so handlers can
// still call apiKeyFromContext / userFromContext on the same Context.
//
// The optional `Path` generic threads the route's literal path through to
// Hono's Context so `c.req.param('id')` narrows to `string` (not `string |
// undefined`) on routes that declare `:id`. Without it, Hono falls back to
// the `string | undefined` overload because `ParamKeys<string>` is `never`,
// forcing handlers to either non-null-assert or guard against an impossible
// case (the router never matches a `:id` route without the param).
export type CtxWithJson<S extends ZodType, Path extends string = string> = Context<{ Variables: AuthVars }, Path, { in: { json: z.infer<S> }; out: { json: z.infer<S> } }>;
export type CtxWithQuery<S extends ZodType, Path extends string = string> = Context<{ Variables: AuthVars }, Path, { in: { query: z.infer<S> }; out: { query: z.infer<S> } }>;

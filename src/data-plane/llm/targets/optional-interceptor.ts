// Descriptor a protocol interceptor index uses to bind an interceptor
// run function to a flag declared in ../../providers/fixes.ts. The
// dependency is one-way: the interceptor knows which flag it subscribes
// to (by id); the flag has no awareness of subscribers. `fixId` is typed
// against the catalog so a typo or rename is a compile error.

import type { OptionalFixId } from '../../providers/fixes.ts';

export interface OptionalInterceptor<TInterceptor> {
  fixId: OptionalFixId;
  run: TInterceptor;
}

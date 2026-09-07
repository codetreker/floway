import { describe, expect, it } from 'vitest';

import { applicationStreamFromDialResult } from '../src/application-stream.ts';

describe('applicationStreamFromDialResult', () => {
  it('coalesces a dial prefix with the first plaintext application write', async () => {
    const writes: Uint8Array[] = [];
    const stream = await applicationStreamFromDialResult({
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>({ write: chunk => { writes.push(chunk.slice()); } }),
      prefix: new Uint8Array([1, 2]),
    }, { host: 'example.com', port: 80, tls: false });

    const writer = stream.writable.getWriter();
    await writer.write(new Uint8Array([3, 4]));
    await writer.write(new Uint8Array([5]));
    expect(writes.map(value => [...value])).toEqual([[1, 2, 3, 4], [5]]);
  });
});

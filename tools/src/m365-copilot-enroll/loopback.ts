import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  assertM365LoopbackRedirectUri,
  type M365LoopbackRedirectUri,
} from '@floway-dev/provider-m365-copilot-web/enrollment';

const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REQUEST_URL_LENGTH = 20 * 1024;
const MAX_AUTHORIZATION_CODE_LENGTH = 16 * 1024;
const LOOPBACK_ADDRESS = '127.0.0.1';

export interface M365LoopbackAuthorization {
  redirectUri: M365LoopbackRedirectUri;
  authorizationCode: Promise<string>;
  close(): Promise<void>;
}

const isLoopbackPeer = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

const hostHeaderValues = (request: IncomingMessage): string[] => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'host') values.push(request.rawHeaders[index + 1] ?? '');
  }
  return values;
};

const respond = (response: ServerResponse, status: number, title: string, message: string): void => {
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><p>${message}</p>`);
};

const redirectToCleanRoot = (response: ServerResponse): void => {
  response.writeHead(302, {
    'cache-control': 'no-store',
    connection: 'close',
    location: '/',
    'referrer-policy': 'no-referrer',
  });
  response.end();
};

const closeServer = (server: Server): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  if (!server.listening) {
    resolvePromise();
    return;
  }
  server.close(error => {
    if (error) rejectPromise(error);
    else resolvePromise();
  });
});

export const listenForM365AuthorizationCode = async (input: {
  expectedState: string;
  timeoutMs?: number;
}): Promise<M365LoopbackAuthorization> => {
  if (input.expectedState.length === 0) throw new Error('Expected OAuth state must not be empty');

  let completed = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let closePromise: Promise<void> | undefined;
  let pending: { kind: 'code'; value: string } | { kind: 'error'; value: string } | undefined;
  const lifecycle: { timer?: ReturnType<typeof setTimeout> } = {};
  const authorizationCode = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCode = resolvePromise;
    rejectCode = rejectPromise;
  });
  void authorizationCode.catch(() => undefined);

  const server = createServer({ maxHeaderSize: MAX_REQUEST_URL_LENGTH + 4096 }, (request, response) => {
    if (completed) {
      respond(response, 410, 'Enrollment complete', 'This enrollment callback has already been consumed.');
      return;
    }

    const fail = (message: string): void => {
      if (pending !== undefined) {
        respond(response, 400, 'Invalid callback', 'Return to the previous tab to finish enrollment.');
        return;
      }
      completed = true;
      if (lifecycle.timer !== undefined) clearTimeout(lifecycle.timer);
      respond(response, 400, 'Enrollment failed', 'Return to the terminal and start enrollment again.');
      rejectCode(new Error(message));
      closePromise ??= closeServer(server);
    };

    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      fail('M365 authorization callback did not originate from a loopback address');
      return;
    }
    if (request.method !== 'GET') {
      fail('M365 authorization callback must use GET');
      return;
    }
    if (request.url === undefined || request.url.length === 0 || request.url.length > MAX_REQUEST_URL_LENGTH
      || !request.url.startsWith('/') || request.url.startsWith('//')) {
      fail('M365 authorization callback URL is invalid or too large');
      return;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      fail('M365 authorization callback server lost its loopback address');
      return;
    }
    const expectedHost = `localhost:${address.port}`;
    const hosts = hostHeaderValues(request);
    if (hosts.length !== 1 || hosts[0] !== expectedHost) {
      fail('M365 authorization callback Host header is invalid');
      return;
    }

    const url = new URL(request.url, `http://${expectedHost}`);
    if (url.pathname !== '/' || url.hash !== '') {
      fail('M365 authorization callback path is invalid');
      return;
    }
    if (request.url === '/') {
      if (pending === undefined) {
        fail('M365 authorization callback reached the clean page before OAuth completed');
        return;
      }
      completed = true;
      if (lifecycle.timer !== undefined) clearTimeout(lifecycle.timer);
      if (pending.kind === 'code') {
        respond(response, 200, 'Enrollment complete', 'Return to Floway to import the enrollment bundle. You can close this tab.');
        resolveCode(pending.value);
      } else {
        respond(response, 400, 'Enrollment failed', 'Return to the terminal and start enrollment again.');
        rejectCode(new Error(`Microsoft authorization failed with ${pending.value}`));
      }
      closePromise ??= closeServer(server);
      return;
    }
    if (pending !== undefined) {
      respond(response, 400, 'Invalid callback', 'Return to the previous tab to finish enrollment.');
      return;
    }
    const states = url.searchParams.getAll('state');
    if (states.length !== 1 || states[0] !== input.expectedState) {
      fail('M365 authorization callback state is invalid');
      return;
    }
    const errors = url.searchParams.getAll('error');
    const codes = url.searchParams.getAll('code');
    if (errors.length > 0) {
      const errorCode = errors.length === 1 && /^[A-Za-z0-9_.-]{1,128}$/.test(errors[0]!) ? errors[0] : 'invalid_error';
      pending = { kind: 'error', value: errorCode };
      redirectToCleanRoot(response);
      return;
    }
    if (codes.length !== 1 || codes[0]!.length === 0 || codes[0]!.length > MAX_AUTHORIZATION_CODE_LENGTH) {
      fail('M365 authorization callback code is missing, duplicated, or too large');
      return;
    }

    pending = { kind: 'code', value: codes[0]! };
    redirectToCleanRoot(response);
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    if (completed || pending !== undefined) return;
    completed = true;
    if (lifecycle.timer !== undefined) clearTimeout(lifecycle.timer);
    rejectCode(new Error('M365 authorization callback request is malformed or too large'));
    closePromise ??= closeServer(server);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      rejectPromise(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, LOOPBACK_ADDRESS);
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.port < 1024 || address.port > 65_535) {
    await closeServer(server);
    throw new Error('Operating system assigned an invalid loopback port');
  }
  const redirectUri = `http://localhost:${address.port}/`;
  assertM365LoopbackRedirectUri(redirectUri);
  server.on('error', error => {
    if (completed) return;
    completed = true;
    if (lifecycle.timer !== undefined) clearTimeout(lifecycle.timer);
    rejectCode(error);
    closePromise ??= closeServer(server);
  });
  lifecycle.timer = setTimeout(() => {
    if (completed) return;
    completed = true;
    rejectCode(new Error('Timed out waiting for Microsoft authorization'));
    closePromise ??= closeServer(server);
  }, input.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS);

  return {
    redirectUri,
    authorizationCode,
    close: async () => {
      if (!completed) {
        completed = true;
        if (lifecycle.timer !== undefined) clearTimeout(lifecycle.timer);
        rejectCode(new Error('M365 authorization callback server was closed'));
      }
      closePromise ??= closeServer(server);
      await closePromise;
    },
  };
};

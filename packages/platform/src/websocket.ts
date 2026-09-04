import type { WebSocketConnector } from '@floway-dev/http';

let connector: WebSocketConnector | null = null;

export const initWebSocketConnector = (implementation: WebSocketConnector): void => {
  connector = implementation;
};

export const getWebSocketConnector = (): WebSocketConnector => {
  if (connector === null) {
    throw new Error('WebSocketConnector not initialized — call initWebSocketConnector() first');
  }
  return connector;
};

export const resetWebSocketConnectorForTesting = (): void => {
  connector = null;
};

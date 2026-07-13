export type GatewayProtocolRequestOptions = {
  timeoutMs?: number | null;
  expectFinal?: boolean;
  /** Called after the request frame has been handed to the WebSocket transport. */
  onDispatched?: () => void;
  onAccepted?: (payload: unknown) => void;
  signal?: AbortSignal;
};

export type Evt = { kind: string; [k: string]: any };

/** Single live channel with auto-reconnect. */
export function connectWS(onEvent: (e: Evt) => void): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (m) => onEvent(JSON.parse(m.data));
  ws.onclose = () => setTimeout(() => connectWS(onEvent), 1000);
  return ws;
}

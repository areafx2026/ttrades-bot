const j = (r: Response) => r.json();

export const api = {
  account: () => fetch("/api/account").then(j),
  zones: (symbol?: string) =>
    fetch(`/api/zones${symbol ? `?symbol=${symbol}` : ""}`).then(j),
  candles: (symbol: string, tf = "H4", count = 120) =>
    fetch(`/api/zones/${symbol}/candles?timeframe=${tf}&count=${count}`).then(j),
  trades: (state?: string) =>
    fetch(`/api/trades${state ? `?state=${state}` : ""}`).then(j),
  status: () => fetch("/api/control/status").then(j),
  kill: (flatten = false) =>
    fetch(`/api/control/kill?flatten=${flatten}`, { method: "POST" }).then(j),
  resume: () => fetch("/api/control/resume", { method: "POST" }).then(j),
  scan: () => fetch("/api/control/scan", { method: "POST" }).then(j),
};

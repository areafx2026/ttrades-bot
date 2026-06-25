import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { State } from "../App";
import { AccountBar } from "../components/AccountBar";
import { ChartPanel } from "../components/ChartPanel";
import { ZoneTable } from "../components/ZoneTable";
import { TradesTable } from "../components/TradesTable";

const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "EURGBP", "EURJPY", "USDCAD",
                 "BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD"];
const TIMEFRAMES = ["D1", "H4", "H1"];   // zones built on D1, entries armed on H4

export function Dashboard({ state }: { state: State }) {
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [tf, setTf] = useState("H4");
  const [candles, setCandles] = useState<any[]>([]);
  const [account, setAccount] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [restZones, setRestZones] = useState<Record<string, any[]>>({});

  // REST hydrate + poll. The engine is the source of truth — account/trades/zones
  // are pulled on load and refreshed, so nothing depends on having caught a live
  // WS event (zones are only pushed on the 6h rescan).
  //
  // Only push to state when the payload actually changed: an unconditional setState
  // every 8s gives every consumer a fresh reference, which made ChartPanel tear down
  // and rebuild the chart on each poll — collapsing its height and bouncing the page
  // scroll to the top. Keeping references stable means an idle poll is a no-op render.
  const lastJson = useRef<{ a?: string; t?: string; z?: string }>({});
  useEffect(() => {
    const setChanged = <T,>(key: "a" | "t" | "z", set: (v: T) => void) => (v: T) => {
      const j = JSON.stringify(v);
      if (j !== lastJson.current[key]) { lastJson.current[key] = j; set(v); }
    };
    const load = () => {
      api.account().then(setChanged("a", setAccount)).catch(() => {});
      api.trades().then(setChanged("t", setTrades)).catch(() => {});
      api.zones().then(setChanged("z", setRestZones)).catch(() => {});
    };
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  // REST gives the full picture on load; live WS zone events (fresher) win per symbol.
  const zonesAll: Record<string, any[]> = { ...restZones, ...state.zones };

  // A live fill arriving over WS triggers an immediate refetch (snappier than
  // waiting for the next poll); closes show on the next 8s tick.
  useEffect(() => {
    if (state.trades.length) api.trades().then(setTrades).catch(() => {});
  }, [state.trades.length]);

  useEffect(() => {
    api.candles(symbol, tf, 150).then(setCandles).catch(() => setCandles([]));
  }, [symbol, tf]);

  const zones = zonesAll[symbol] ?? [];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 20 }}>
      <h1 style={{ fontSize: 20, margin: "0 0 16px" }}>
        Pivot <span style={{ color: "#8b949e" }}>v3.0</span> — S/R Areas of Interest
      </h1>

      <AccountBar account={account ?? state.account} autoEnabled={state.autoEnabled} />

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {SYMBOLS.map((s) => (
          <button key={s} onClick={() => setSymbol(s)} style={{
            padding: "6px 12px", borderRadius: 6, cursor: "pointer",
            border: "1px solid #30363d",
            background: s === symbol ? "#1f6feb" : "#161b22",
            color: "#fff", fontWeight: s === symbol ? 700 : 400,
          }}>{s}</button>
        ))}
      </div>

      <div style={{ background: "#161b22", borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                      marginBottom: 8 }}>
          <div style={{ fontWeight: 600 }}>
            {symbol} <span style={{ color: "#8b949e" }}>· {tf}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {TIMEFRAMES.map((f) => (
              <button key={f} onClick={() => setTf(f)} style={{
                padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                border: "1px solid #30363d", fontSize: 12,
                background: f === tf ? "#1f6feb" : "#0e1117",
                color: "#fff", fontWeight: f === tf ? 700 : 400,
              }}>{f}</button>
            ))}
          </div>
        </div>
        <ChartPanel candles={candles} zones={zones} symbol={symbol} />
      </div>

      <ZoneTable zones={{ [symbol]: zonesAll[symbol] ?? [] }} />
      <TradesTable trades={trades} />
    </div>
  );
}

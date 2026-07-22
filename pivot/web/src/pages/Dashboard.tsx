import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { State } from "../App";
import { AccountBar } from "../components/AccountBar";
import { HourOfDayChart } from "../components/HourOfDayChart";
import { ZoneTable } from "../components/ZoneTable";
import { TradesTable } from "../components/TradesTable";

const SYMBOLS = ["EURUSD", "USDJPY", "GBPUSD", "USDCHF", "AUDUSD", "USDCAD",
                 "EURGBP", "EURJPY",
                 "BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD"];

export function Dashboard({ state }: { state: State }) {
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [account, setAccount] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [restZones, setRestZones] = useState<Record<string, any[]>>({});
  const [botName, setBotName] = useState("Pivot");
  const [brokerOffsetH, setBrokerOffsetH] = useState(0);
  const [blockedHours, setBlockedHours] = useState<number[]>([]);

  useEffect(() => {
    api.status().then((s: any) => {
      if (s?.bot_name) setBotName(s.bot_name);
      if (typeof s?.broker_utc_offset_h === "number") setBrokerOffsetH(s.broker_utc_offset_h);
      if (Array.isArray(s?.hour_blackout_hours)) setBlockedHours(s.hour_blackout_hours);
    }).catch(() => {});
  }, []);

  // REST hydrate + poll. The engine is the source of truth — account/trades/zones
  // are pulled on load and refreshed, so nothing depends on having caught a live
  // WS event (zones are only pushed on the 6h rescan).
  //
  // Only push to state when the payload actually changed: an unconditional setState
  // every 8s gives every consumer a fresh reference on every poll, forcing needless
  // re-renders. Keeping references stable means an idle poll is a no-op render.
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

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                    marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>
          {botName} <span style={{ color: "#8b949e" }}>— S/R Areas of Interest</span>
        </h1>
        <a href="/compare" style={{ color: "#58a6ff", fontSize: 13, textDecoration: "none" }}>
          Vergleich v3 / v4 →
        </a>
      </div>

      <AccountBar account={account ?? state.account} autoEnabled={state.autoEnabled} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {SYMBOLS.map((s) => (
          <button key={s} onClick={() => setSymbol(s)} style={{
            padding: "6px 12px", borderRadius: 6, cursor: "pointer",
            border: "1px solid #30363d",
            background: s === symbol ? "#1f6feb" : "#161b22",
            color: "#fff", fontWeight: s === symbol ? 700 : 400,
          }}>{s}</button>
        ))}
      </div>

      <HourOfDayChart trades={trades} brokerOffsetH={brokerOffsetH} blockedHours={blockedHours} />

      <ZoneTable zones={{ [symbol]: zonesAll[symbol] ?? [] }} />
      <TradesTable trades={trades} />
    </div>
  );
}

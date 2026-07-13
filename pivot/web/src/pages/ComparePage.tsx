import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, IChartApi } from "lightweight-charts";

// Fixed, known topology: v3 on :8000, v4 on :8001, same MT5 account, separate
// DBs. Hardcoded on purpose — this compares exactly these two instances, no
// need to make it generic.
const BACKENDS = [
  { key: "v3", base: "http://127.0.0.1:8000", color: "#58a6ff" },
  { key: "v4", base: "http://127.0.0.1:8001", color: "#d29922" },
] as const;

type Trade = {
  state: string; result: string | null; pnl_eur: number | null;
  risk_eur: number | null; opened_at: string | null; closed_at: string | null;
};

type BotData = {
  label: string;
  zoneTf: string;
  entryTf: string;
  trades: Trade[];
  error: string | null;
};

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

function stats(d: BotData) {
  const closed = d.trades.filter((t) => t.state === "CLOSED");
  const wins = closed.filter((t) => t.result === "WIN").length;
  const losses = closed.filter((t) => t.result === "LOSS").length;
  const decided = wins + losses;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl_eur ?? 0), 0);
  const rSamples = closed
    .filter((t) => t.risk_eur && t.pnl_eur != null)
    .map((t) => (t.pnl_eur as number) / (t.risk_eur as number));
  const avgR = rSamples.length ? rSamples.reduce((a, b) => a + b, 0) / rSamples.length : null;
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recentOpens = d.trades.filter(
    (t) => t.opened_at && new Date(t.opened_at).getTime() >= sevenDaysAgo
  ).length;
  const open = d.trades.filter((t) => t.state === "OPEN").length;
  return {
    total: d.trades.length, closedN: closed.length, open,
    winRate: decided ? wins / decided : null,
    totalPnl, avgR, tradesPerDay: recentOpens / 7,
  };
}

/** Cumulative P&L by TRADE NUMBER, not calendar date — v3 and v4 started
 * trading at different real dates, so an absolute-time x-axis would leave
 * the later starter's curve squashed against the right edge instead of
 * both beginning together on the left. `time` here is a 1-based trade
 * index encoded as a lightweight-charts UTCTimestamp (any ascending integer
 * works); EquityChart's tickMarkFormatter relabels it as "Trade N". */
function equityCurve(d: BotData): { time: number; value: number }[] {
  const closed = d.trades
    .filter((t) => t.state === "CLOSED" && t.closed_at && t.pnl_eur != null)
    .sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime());
  let cum = 0;
  return closed.map((t, i) => {
    cum += t.pnl_eur as number;
    return { time: i + 1, value: Math.round(cum * 100) / 100 };
  });
}

function EquityChart({ series }: { series: { data: { time: number; value: number }[]; color: string; label: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>();

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height: 320,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0e1117" }, textColor: "#c9d1d9" },
      grid: { vertLines: { color: "#1b1f27" }, horzLines: { color: "#1b1f27" } },
      // x-axis is a trade index (see equityCurve), not a real date — relabel
      // the lightweight-charts time axis accordingly instead of showing
      // "Jan 1 1970"-style dates for small integers.
      timeScale: {
        timeVisible: false,
        tickMarkFormatter: (time: number) => `#${time}`,
      },
      localization: {
        timeFormatter: (time: number) => `Trade #${time}`,
      },
    });
    chartRef.current = chart;
    series.forEach((s) => {
      if (!s.data.length) return;
      const line = chart.addLineSeries({ color: s.color, lineWidth: 2, title: s.label });
      line.setData(s.data as any);
    });
    return () => chart.remove();
  }, [series]);

  return <div ref={ref} style={{ width: "100%", height: 320 }} />;
}

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);
const eur = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}€`;
const num = (v: number | null, d = 2) => (v == null ? "—" : v.toFixed(d));

type Stats = ReturnType<typeof stats>;
const STAT_ROWS: { label: string; fmt: (s: Stats) => string }[] = [
  { label: "Trades gesamt (offen/geschlossen)", fmt: (s) => `${s.total} (${s.open} offen)` },
  { label: "Trades/Tag (letzte 7 Tage)", fmt: (s) => num(s.tradesPerDay, 1) },
  { label: "Win-Rate", fmt: (s) => pct(s.winRate) },
  { label: "Gesamt-P/L (realisiert)", fmt: (s) => eur(s.totalPnl) },
  { label: "Ø realisiertes R", fmt: (s) => num(s.avgR, 2) },
];

export function ComparePage() {
  const [data, setData] = useState<Record<string, BotData>>({});

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      Promise.all(
        BACKENDS.map(async (b) => {
          try {
            const [status, trades] = await Promise.all([
              fetch(`${b.base}/api/control/status`, { cache: "no-store" }).then(j),
              fetch(`${b.base}/api/trades?limit=500`, { cache: "no-store" }).then(j),
            ]);
            return [b.key, {
              label: status.bot_name ?? b.key,
              zoneTf: status.zone_timeframe ?? "?",
              entryTf: status.entry_timeframe ?? "?",
              trades, error: null,
            }] as const;
          } catch (e) {
            return [b.key, {
              label: b.key, zoneTf: "?", entryTf: "?", trades: [],
              error: `nicht erreichbar auf ${b.base} (läuft die Instanz?)`,
            }] as const;
          }
        })
      ).then((entries) => { if (!cancelled) setData(Object.fromEntries(entries)); });
    };
    load();
    const t = setInterval(load, 8000);   // same cadence as the main Dashboard's poll
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const rows = BACKENDS.map((b) => ({ b, d: data[b.key] }));
  const chartSeries = rows
    .filter((r) => r.d && !r.d.error)
    .map((r) => ({ data: equityCurve(r.d!), color: r.b.color, label: r.d!.label }));

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 20, color: "#c9d1d9" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Vergleich v3 / v4</h1>
        <a href="/" style={{ color: "#58a6ff", fontSize: 13, textDecoration: "none" }}>← zurück zum Dashboard</a>
      </div>

      <div style={{ background: "#161b22", borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Kumulierter P/L (realisiert)
          <span style={{ color: "#8b949e", fontWeight: 400 }}> — nach Trade-Nummer, nicht Kalenderdatum</span>
        </div>
        {chartSeries.some((s) => s.data.length) ? (
          <EquityChart series={chartSeries} />
        ) : (
          <div style={{ color: "#8b949e", padding: 20 }}>Noch keine geschlossenen Trades auf beiden Instanzen.</div>
        )}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", background: "#161b22", borderRadius: 8, overflow: "hidden" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #30363d" }}>
            <th style={{ padding: "10px 12px" }}></th>
            {rows.map(({ b, d }) => (
              <th key={b.key} style={{ padding: "10px 12px", color: b.color }}>
                {d?.label ?? b.key} <span style={{ color: "#8b949e", fontWeight: 400 }}>
                  ({d ? `${d.zoneTf}/${d.entryTf}` : "…"})
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.some(({ d }) => d?.error) && (
            <tr>
              <td style={{ padding: "10px 12px", color: "#8b949e" }}>Status</td>
              {rows.map(({ b, d }) => (
                <td key={b.key} style={{ padding: "10px 12px", color: d?.error ? "#f85149" : "#3fb950" }}>
                  {d?.error ?? "verbunden"}
                </td>
              ))}
            </tr>
          )}
          {STAT_ROWS.map(({ label, fmt }) => (
            <tr key={label} style={{ borderTop: "1px solid #21262d" }}>
              <td style={{ padding: "10px 12px", color: "#8b949e" }}>{label}</td>
              {rows.map(({ b, d }) => (
                <td key={b.key} style={{ padding: "10px 12px" }}>
                  {d && !d.error ? fmt(stats(d)) : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

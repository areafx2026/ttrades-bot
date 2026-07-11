import type { CSSProperties } from "react";

const C = {
  win: "#3fb950", loss: "#f85149", open: "#58a6ff",
  muted: "#8b949e", border: "#21262d", panel: "#161b22",
};

const CRYPTO = new Set(["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD"]);

/** Price display matched to the instrument: forex 4 dp, JPY pairs 3 dp,
 *  crypto adaptive (BTC/ETH 2 dp, sub-€1 coins like DOGE/XRP 5 dp). */
function px(symbol: string, n: any): string {
  if (n == null) return "—";
  const v = Number(n);
  if (CRYPTO.has(symbol)) return Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(5);
  if (symbol.includes("JPY")) return v.toFixed(3);
  return v.toFixed(4);
}

const eur = (n: any) => (n == null ? "—" : `€${Number(n).toFixed(2)}`);
const pips = (n: any) => (n == null ? "—" : Number(n).toFixed(1));

/** minutes → compact "1d 3h" / "45m" */
function hold(min: any): string {
  if (min == null) return "—";
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  const parts = [d && `${d}d`, h && `${h}h`, !d && m && `${m}m`].filter(Boolean);
  return parts.length ? parts.join(" ") : "0m";
}

/** excursion pips + (% of SL/TP) */
function exc(p: any, pct: any): string {
  if (p == null) return "—";
  return pct != null ? `${pips(p)} (${Math.round(pct * 100)}%)` : pips(p);
}

const CLOSE_REASON_LABEL: Record<string, string> = {
  stale_timeout: "Zeit-Stop: MFE-Schwelle nicht erreicht",
};

function StateCell({ t }: { t: any }) {
  if (t.state === "CLOSED") {
    const c = t.result === "WIN" ? C.win : t.result === "LOSS" ? C.loss : C.muted;
    const reasonTitle = t.close_reason ? CLOSE_REASON_LABEL[t.close_reason] ?? t.close_reason : undefined;
    return (
      <span style={{ color: c, fontWeight: 700 }} title={reasonTitle}>
        {t.result ?? "CLOSED"}
        {t.close_reason === "stale_timeout" && (
          <span style={{ color: C.muted, fontWeight: 400 }}> ⏱</span>
        )}
      </span>
    );
  }
  if (t.state === "OPEN") return <span style={{ color: C.open, fontWeight: 600 }}>OPEN</span>;
  return <span style={{ color: C.muted }}>{t.state}</span>;
}

const th: CSSProperties = { padding: "0 8px 8px 0", fontWeight: 500 };
const td: CSSProperties = { padding: "6px 8px 6px 0", whiteSpace: "nowrap" };

export function TradesTable({ trades }: { trades: any[] }) {
  const open = trades.filter((t) => t.state === "OPEN").length;
  return (
    <div style={{ background: C.panel, borderRadius: 8, padding: 12, marginTop: 16, overflowX: "auto" }}>
      <h3 style={{ margin: "4px 0 12px" }}>
        Trades <span style={{ color: C.muted, fontWeight: 400, fontSize: 13 }}>
          ({trades.length} total, {open} open)
        </span>
      </h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: C.muted, textAlign: "left" }}>
            <th style={th}>Symbol</th><th style={th}>Side</th><th style={th}>State</th>
            <th style={th}>Fill</th><th style={th}>SL</th><th style={th}>TP</th>
            <th style={th}>Close</th><th style={th}>Lots</th>
            <th style={th}>P&amp;L</th><th style={th}>Pips</th>
            <th style={th}>MAE</th><th style={th}>MFE</th><th style={th}>Hold</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={t.ticket ?? t.id ?? i} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ ...td, fontWeight: 600 }}>{t.symbol}</td>
              <td style={{ ...td, color: t.side === "BUY" ? C.win : C.loss }}>{t.side}</td>
              <td style={td}><StateCell t={t} /></td>
              <td style={td}>{px(t.symbol, t.fill_price ?? t.entry)}</td>
              <td style={td}>{px(t.symbol, t.sl)}</td>
              <td style={td}>{px(t.symbol, t.tp)}</td>
              <td style={td}>{px(t.symbol, t.close_price)}</td>
              <td style={td}>{t.lots ?? "—"}</td>
              <td style={{ ...td, fontWeight: 600, color: (t.pnl_eur ?? 0) >= 0 ? C.win : C.loss }}>
                {eur(t.pnl_eur)}
              </td>
              <td style={td}>{pips(t.pnl_pips)}</td>
              <td style={{ ...td, color: C.muted }}>{exc(t.mae_pips, t.mae_pct_of_sl)}</td>
              <td style={{ ...td, color: C.muted }}>{exc(t.mfe_pips, t.mfe_pct_of_tp)}</td>
              <td style={{ ...td, color: C.muted }}>{hold(t.hold_duration_min)}</td>
            </tr>
          ))}
          {trades.length === 0 && (
            <tr><td colSpan={13} style={{ padding: 12, color: C.muted }}>No trades yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

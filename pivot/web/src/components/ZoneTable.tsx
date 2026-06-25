type Zone = { low: number; high: number; mid: number; touches: number;
              support: number; resist: number };

const CRYPTO = new Set(["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD"]);

/** Price display matched to the instrument (same buckets as the chart axis). */
function px(symbol: string, n: any): string {
  if (n == null) return "—";
  const v = Number(n);
  if (CRYPTO.has(symbol)) return Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(5);
  if (symbol.includes("JPY")) return v.toFixed(3);
  return v.toFixed(4);
}

export function ZoneTable({ zones }: { zones: Record<string, Zone[]> }) {
  const rows = Object.entries(zones).flatMap(([sym, zs]) =>
    zs.map((z) => ({ sym, ...z })));

  return (
    <div style={{ background: "#161b22", borderRadius: 8, padding: 12 }}>
      <h3 style={{ margin: "4px 0 12px" }}>Areas of Interest</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "#8b949e", textAlign: "left" }}>
            <th>Symbol</th><th>Low</th><th>Mid</th><th>High</th>
            <th>Touches</th><th>▲S</th><th>▼R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid #21262d" }}>
              <td style={{ padding: "6px 0", fontWeight: 600 }}>{r.sym}</td>
              <td>{px(r.sym, r.low)}</td>
              <td style={{ color: "#d29922" }}>{px(r.sym, r.mid)}</td>
              <td>{px(r.sym, r.high)}</td>
              <td>{r.touches}</td>
              <td style={{ color: "#3fb950" }}>{r.support}</td>
              <td style={{ color: "#f85149" }}>{r.resist}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={7} style={{ padding: 12, color: "#8b949e" }}>No valid zones yet — scanning…</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

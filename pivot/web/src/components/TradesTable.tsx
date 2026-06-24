export function TradesTable({ trades }: { trades: any[] }) {
  return (
    <div style={{ background: "#161b22", borderRadius: 8, padding: 12, marginTop: 16 }}>
      <h3 style={{ margin: "4px 0 12px" }}>Trades</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "#8b949e", textAlign: "left" }}>
            <th>Symbol</th><th>Side</th><th>Entry</th><th>SL</th><th>TP</th>
            <th>Lots</th><th>State</th><th>P&L</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={t.ticket ?? i} style={{ borderTop: "1px solid #21262d" }}>
              <td style={{ padding: "6px 0", fontWeight: 600 }}>{t.symbol}</td>
              <td style={{ color: t.side === "BUY" ? "#3fb950" : "#f85149" }}>{t.side}</td>
              <td>{t.entry}</td><td>{t.sl}</td><td>{t.tp}</td>
              <td>{t.lots}</td><td>{t.state}</td>
              <td style={{ color: (t.pnl_eur ?? 0) >= 0 ? "#3fb950" : "#f85149" }}>
                {t.pnl_eur != null ? `€${t.pnl_eur.toFixed(2)}` : "—"}
              </td>
            </tr>
          ))}
          {trades.length === 0 && (
            <tr><td colSpan={8} style={{ padding: 12, color: "#8b949e" }}>No trades yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

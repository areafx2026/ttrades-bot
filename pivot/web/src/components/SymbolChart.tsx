type Trade = { symbol?: string | null; state: string; result?: string | null };

/** The full tradeable universe (config.py's default `symbols`, which is
 * v3's list — the superset). Always shown in full so the chart's shape
 * doesn't shift as trades accumulate; instruments this instance doesn't
 * currently trade (e.g. crypto on v4) are shown zeroed-out and marked
 * blocked rather than simply missing. */
const ALL_SYMBOLS = [
  "EURUSD", "USDJPY", "GBPUSD", "USDCHF", "AUDUSD", "USDCAD",
  "EURGBP", "EURJPY",
  "BTCUSD", "ETHUSD", "DOGEUSD",
];

/** Win/Loss counts bucketed by symbol — same visual language as
 * HourOfDayChart, just grouped by instrument instead of entry hour. */
function bucketBySymbol(trades: Trade[]): Record<string, { win: number; loss: number }> {
  const buckets: Record<string, { win: number; loss: number }> = {};
  for (const t of trades) {
    if (t.state !== "CLOSED" || !t.symbol) continue;
    if (t.result !== "WIN" && t.result !== "LOSS") continue;
    const b = buckets[t.symbol] ?? (buckets[t.symbol] = { win: 0, loss: 0 });
    b[t.result === "WIN" ? "win" : "loss"]++;
  }
  return buckets;
}

export function SymbolChart({ trades, tradeableSymbols }:
                             { trades: Trade[]; tradeableSymbols?: string[] }) {
  const buckets = bucketBySymbol(trades);
  // Any symbol with trade history (even one no longer configured, e.g. the
  // fully-retired XRPUSD/SOLUSD) still gets a column — union, not just the
  // fixed master list.
  const symbols = [...new Set([...ALL_SYMBOLS, ...Object.keys(buckets)])];
  const tradeable = tradeableSymbols ? new Set(tradeableSymbols) : null;
  const blocked = new Set(tradeable ? symbols.filter((s) => !tradeable.has(s)) : []);

  const tradedSymbols = symbols.filter((s) => buckets[s]);
  const totalTrades = tradedSymbols.reduce((s, sym) => s + buckets[sym].win + buckets[sym].loss, 0);
  const max = Math.max(1, ...tradedSymbols.map((sym) => Math.max(buckets[sym].win, buckets[sym].loss)));

  const n = Math.max(symbols.length, 1);
  const W = 1160, H = 210, padTop = 16, padBottom = 26, groupW = W / n, barGap = 2;
  const barW = (groupW - barGap * 3) / 2;
  const barAreaH = H - padTop - padBottom;

  const bestWinSymbol = tradedSymbols.reduce(
    (best, sym) => (!best || buckets[sym].win > buckets[best].win ? sym : best), tradedSymbols[0]);
  const worstLossSymbol = tradedSymbols.reduce(
    (worst, sym) => (!worst || buckets[sym].loss > buckets[worst].loss ? sym : worst), tradedSymbols[0]);

  return (
    <div style={{ background: "#161b22", borderRadius: 8, padding: 12, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Win/Loss nach Symbol
      </div>
      {totalTrades === 0 ? (
        <div style={{ color: "#8b949e", padding: 20 }}>Noch keine geschlossenen Trades.</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
            Meiste Wins: <span style={{ color: "#3fb950" }}>{bestWinSymbol}</span> ({buckets[bestWinSymbol].win})
            {"  ·  "}
            Meiste Losses: <span style={{ color: "#f85149" }}>{worstLossSymbol}</span> ({buckets[worstLossSymbol].loss})
            {blocked.size > 0 && (
              <>
                {"  ·  "}
                🔒 nicht gehandelt: {[...blocked].sort().join(", ")}
              </>
            )}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
            {symbols.map((sym, i) => {
              const x = i * groupW;
              const isBlocked = blocked.has(sym);
              const b = buckets[sym] ?? { win: 0, loss: 0 };
              const winH = (b.win / max) * barAreaH;
              const lossH = (b.loss / max) * barAreaH;
              return (
                <g key={sym}>
                  {isBlocked && (
                    <rect x={x} y={padTop} width={groupW} height={barAreaH}
                          fill="#f85149" opacity={0.08} />
                  )}
                  <rect x={x + barGap} y={H - padBottom - winH} width={barW} height={winH} fill="#3fb950" />
                  <rect x={x + barGap * 2 + barW} y={H - padBottom - lossH} width={barW} height={lossH} fill="#f85149" />
                  {isBlocked && (
                    <text x={x + groupW / 2} y={padTop + 2} fontSize="11" textAnchor="middle" dominantBaseline="hanging">🔒</text>
                  )}
                  <text x={x + groupW / 2} y={H - 10} fontSize="10"
                        fill={isBlocked ? "#f85149" : "#8b949e"} textAnchor="middle">{sym}</text>
                </g>
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}

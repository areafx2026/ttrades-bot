type Trade = { symbol?: string | null; state: string; result?: string | null };

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

export function SymbolChart({ trades }: { trades: Trade[] }) {
  const buckets = bucketBySymbol(trades);
  const symbols = Object.keys(buckets).sort();
  const totalTrades = symbols.reduce((s, sym) => s + buckets[sym].win + buckets[sym].loss, 0);
  const max = Math.max(1, ...symbols.map((sym) => Math.max(buckets[sym].win, buckets[sym].loss)));

  const n = Math.max(symbols.length, 1);
  const W = 1160, H = 210, padTop = 16, padBottom = 26, groupW = W / n, barGap = 2;
  const barW = (groupW - barGap * 3) / 2;
  const barAreaH = H - padTop - padBottom;

  const bestWinSymbol = symbols.reduce((best, sym) => (buckets[sym].win > buckets[best].win ? sym : best), symbols[0]);
  const worstLossSymbol = symbols.reduce((worst, sym) => (buckets[sym].loss > buckets[worst].loss ? sym : worst), symbols[0]);

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
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
            {symbols.map((sym, i) => {
              const x = i * groupW;
              const b = buckets[sym];
              const winH = (b.win / max) * barAreaH;
              const lossH = (b.loss / max) * barAreaH;
              return (
                <g key={sym}>
                  <rect x={x + barGap} y={H - padBottom - winH} width={barW} height={winH} fill="#3fb950" />
                  <rect x={x + barGap * 2 + barW} y={H - padBottom - lossH} width={barW} height={lossH} fill="#f85149" />
                  <text x={x + groupW / 2} y={H - 10} fontSize="10" fill="#8b949e" textAnchor="middle">{sym}</text>
                </g>
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}

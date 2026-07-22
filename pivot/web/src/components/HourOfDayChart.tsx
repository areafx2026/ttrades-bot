type Trade = { opened_at?: string | null; state: string; result?: string | null };

/** Win/Loss counts bucketed by the BROKER-LOCAL hour a trade was opened —
 * entry timing is what a trader can actually act on (avoid trading certain
 * hours), unlike close hour which is mostly a function of hold duration. */
function bucketByHour(trades: Trade[], offsetH: number): { win: number; loss: number }[] {
  const buckets = Array.from({ length: 24 }, () => ({ win: 0, loss: 0 }));
  for (const t of trades) {
    if (t.state !== "CLOSED" || !t.opened_at) continue;
    if (t.result !== "WIN" && t.result !== "LOSS") continue;
    const h = (new Date(t.opened_at).getUTCHours() + offsetH + 24) % 24;
    buckets[h][t.result === "WIN" ? "win" : "loss"]++;
  }
  return buckets;
}

const hh = (h: number) => String(h).padStart(2, "0");

export function HourOfDayChart({ trades, brokerOffsetH }: { trades: Trade[]; brokerOffsetH: number }) {
  const buckets = bucketByHour(trades, brokerOffsetH);
  const totalTrades = buckets.reduce((s, b) => s + b.win + b.loss, 0);
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.win, b.loss)));

  const W = 1160, H = 200, padBottom = 22, groupW = W / 24, barGap = 2;
  const barW = (groupW - barGap * 3) / 2;

  const bestWinHour = buckets.reduce((best, b, h) => (b.win > buckets[best].win ? h : best), 0);
  const worstLossHour = buckets.reduce((worst, b, h) => (b.loss > buckets[worst].loss ? h : worst), 0);

  return (
    <div style={{ background: "#161b22", borderRadius: 8, padding: 12, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Win/Loss nach Uhrzeit
        <span style={{ color: "#8b949e", fontWeight: 400 }}> — Broker-Zeit, nach Entry-Stunde (alle Symbole)</span>
      </div>
      {totalTrades === 0 ? (
        <div style={{ color: "#8b949e", padding: 20 }}>Noch keine geschlossenen Trades.</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
            Meiste Wins: <span style={{ color: "#3fb950" }}>{hh(bestWinHour)}:00</span> ({buckets[bestWinHour].win})
            {"  ·  "}
            Meiste Losses: <span style={{ color: "#f85149" }}>{hh(worstLossHour)}:00</span> ({buckets[worstLossHour].loss})
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
            {buckets.map((b, h) => {
              const x = h * groupW;
              const winH = (b.win / max) * (H - padBottom);
              const lossH = (b.loss / max) * (H - padBottom);
              return (
                <g key={h}>
                  <rect x={x + barGap} y={H - padBottom - winH} width={barW} height={winH} fill="#3fb950" />
                  <rect x={x + barGap * 2 + barW} y={H - padBottom - lossH} width={barW} height={lossH} fill="#f85149" />
                  {h % 2 === 0 && (
                    <text x={x + groupW / 2} y={H - 6} fontSize="9" fill="#8b949e" textAnchor="middle">{h}</text>
                  )}
                </g>
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}

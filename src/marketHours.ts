// Returns true if Forex market is currently open (UTC)
// Sun 21:05 UTC open → Fri 21:00 UTC close
// Daily break: 20:55 - 21:05 UTC (Mon-Thu)

export function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();     // 0=Sun, 1=Mon ... 5=Fri, 6=Sat
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Saturday: always closed
  if (day === 6) return false;

  // Sunday: open only after 21:05 UTC
  if (day === 0) return min >= 21 * 60 + 5;

  // Friday: closed after 21:00 UTC
  if (day === 5) return min < 21 * 60;

  // Mon-Thu: closed during daily break 20:55-21:05 UTC
  if (min >= 20 * 60 + 55 && min < 21 * 60 + 5) return false;

  return true;
}

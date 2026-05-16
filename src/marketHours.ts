// Returns true if Forex market is currently open (UTC)
// Sun 21:05 UTC open → Fri 21:00 UTC close
// Daily break: 20:55 - 21:05 UTC (Mon-Thu)

export function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (day === 6) return false;
  if (day === 0) return min >= 21 * 60 + 5;
  if (day === 5) return min < 21 * 60;
  if (min >= 20 * 60 + 55 && min < 21 * 60 + 5) return false;

  return true;
}

// Returns true if current time is within an active trading session
// London Open: 08:30–10:30 MEZ = 07:30–09:30 UTC
// NY Open:     14:30–16:30 MEZ = 13:30–15:30 UTC
// (MEZ = UTC+1, MESZ = UTC+2 — we use conservative UTC times)
export function isActiveTradingSession(): boolean {
  if (!isMarketOpen()) return false;

  const now = new Date();
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Detect DST: MESZ (UTC+2) from last Sunday March to last Sunday October
  // During MESZ: MEZ times shift 1h earlier in UTC
  const isDST = isDaylightSavingTime(now);
  const offset = isDST ? 2 : 1; // UTC+2 in summer, UTC+1 in winter

  // London Open: 08:30–10:30 MEZ
  const londonStart = (8 * 60 + 30) - offset * 60;
  const londonEnd   = (10 * 60 + 30) - offset * 60;

  // NY Open: 14:30–16:30 MEZ
  const nyStart = (14 * 60 + 30) - offset * 60;
  const nyEnd   = (16 * 60 + 30) - offset * 60;

  const inLondon = min >= londonStart && min < londonEnd;
  const inNY     = min >= nyStart     && min < nyEnd;

  return inLondon || inNY;
}

export function getActiveSession(): string | null {
  if (!isMarketOpen()) return null;

  const now = new Date();
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const isDST = isDaylightSavingTime(now);
  const offset = isDST ? 2 : 1;

  const londonStart = (8 * 60 + 30) - offset * 60;
  const londonEnd   = (10 * 60 + 30) - offset * 60;
  const nyStart     = (14 * 60 + 30) - offset * 60;
  const nyEnd       = (16 * 60 + 30) - offset * 60;

  if (min >= londonStart && min < londonEnd) return 'London Open';
  if (min >= nyStart     && min < nyEnd)     return 'NY Open';
  return null;
}

function isDaylightSavingTime(date: Date): boolean {
  const year = date.getUTCFullYear();
  // Last Sunday in March
  const marchEnd = lastSundayOf(year, 2); // month 2 = March (0-indexed)
  // Last Sunday in October
  const octEnd = lastSundayOf(year, 9);   // month 9 = October
  return date >= marchEnd && date < octEnd;
}

function lastSundayOf(year: number, month: number): Date {
  const d = new Date(Date.UTC(year, month + 1, 0)); // last day of month
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // go back to Sunday
  d.setUTCHours(1, 0, 0, 0); // 01:00 UTC = 02:00 MEZ (clocks change)
  return d;
}

// ─── Crypto ───────────────────────────────────────────────────────────────────
export const CRYPTO_SYMBOLS = ['BTCUSD', 'ETHUSD', 'XRPUSD'];
export function isCrypto(symbol: string): boolean { return CRYPTO_SYMBOLS.includes(symbol); }

// ─── Broker/UTC Zeitkonvertierung ─────────────────────────────────────────────
// Pepperstone MT5: UTC+3 während US DST (2. Sonntag März - 1. Sonntag Nov)
//                 UTC+2 sonst

function isUsDaylightSavingTime(date: Date): boolean {
  const year = date.getUTCFullYear();
  const marchSecondSunday = new Date(Date.UTC(year, 2, 1));
  marchSecondSunday.setUTCDate(1 + (7 - marchSecondSunday.getUTCDay()) % 7 + 7);
  marchSecondSunday.setUTCHours(7);
  const novFirstSunday = new Date(Date.UTC(year, 10, 1));
  novFirstSunday.setUTCDate(1 + (7 - novFirstSunday.getUTCDay()) % 7);
  novFirstSunday.setUTCHours(6);
  return date >= marchSecondSunday && date < novFirstSunday;
}

export function brokerToUtc(brokerTimeStr: string): string {
  const naive = brokerTimeStr.endsWith('Z') ? brokerTimeStr.slice(0, -1) : brokerTimeStr;
  const brokerDate = new Date(naive + 'Z');
  const offsetHours = isUsDaylightSavingTime(brokerDate) ? 3 : 2;
  return new Date(brokerDate.getTime() - offsetHours * 3600000).toISOString();
}

export function utcToDisplay(utcIso: string): string {
  return new Date(utcIso).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

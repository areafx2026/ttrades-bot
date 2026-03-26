"use strict";
// Returns true if Forex market is currently open (UTC)
// Sun 21:05 UTC open → Fri 21:00 UTC close
// Daily break: 20:55 - 21:05 UTC (Mon-Thu)
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMarketOpen = isMarketOpen;
exports.isActiveTradingSession = isActiveTradingSession;
exports.getActiveSession = getActiveSession;
function isMarketOpen() {
    const now = new Date();
    const day = now.getUTCDay();
    const min = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (day === 6)
        return false;
    if (day === 0)
        return min >= 21 * 60 + 5;
    if (day === 5)
        return min < 21 * 60;
    if (min >= 20 * 60 + 55 && min < 21 * 60 + 5)
        return false;
    return true;
}
// Returns true if current time is within an active trading session
// London Open: 08:30–10:30 MEZ = 07:30–09:30 UTC
// NY Open:     14:30–16:30 MEZ = 13:30–15:30 UTC
// (MEZ = UTC+1, MESZ = UTC+2 — we use conservative UTC times)
function isActiveTradingSession() {
    if (!isMarketOpen())
        return false;
    const now = new Date();
    const min = now.getUTCHours() * 60 + now.getUTCMinutes();
    // Detect DST: MESZ (UTC+2) from last Sunday March to last Sunday October
    // During MESZ: MEZ times shift 1h earlier in UTC
    const isDST = isDaylightSavingTime(now);
    const offset = isDST ? 2 : 1; // UTC+2 in summer, UTC+1 in winter
    // London Open: 08:30–10:30 MEZ
    const londonStart = (8 * 60 + 30) - offset * 60;
    const londonEnd = (10 * 60 + 30) - offset * 60;
    // NY Open: 14:30–16:30 MEZ
    const nyStart = (14 * 60 + 30) - offset * 60;
    const nyEnd = (16 * 60 + 30) - offset * 60;
    const inLondon = min >= londonStart && min < londonEnd;
    const inNY = min >= nyStart && min < nyEnd;
    return inLondon || inNY;
}
function getActiveSession() {
    if (!isMarketOpen())
        return null;
    const now = new Date();
    const min = now.getUTCHours() * 60 + now.getUTCMinutes();
    const isDST = isDaylightSavingTime(now);
    const offset = isDST ? 2 : 1;
    const londonStart = (8 * 60 + 30) - offset * 60;
    const londonEnd = (10 * 60 + 30) - offset * 60;
    const nyStart = (14 * 60 + 30) - offset * 60;
    const nyEnd = (16 * 60 + 30) - offset * 60;
    if (min >= londonStart && min < londonEnd)
        return 'London Open';
    if (min >= nyStart && min < nyEnd)
        return 'NY Open';
    return null;
}
function isDaylightSavingTime(date) {
    const year = date.getUTCFullYear();
    // Last Sunday in March
    const marchEnd = lastSundayOf(year, 2); // month 2 = March (0-indexed)
    // Last Sunday in October
    const octEnd = lastSundayOf(year, 9); // month 9 = October
    return date >= marchEnd && date < octEnd;
}
function lastSundayOf(year, month) {
    const d = new Date(Date.UTC(year, month + 1, 0)); // last day of month
    d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // go back to Sunday
    d.setUTCHours(1, 0, 0, 0); // 01:00 UTC = 02:00 MEZ (clocks change)
    return d;
}

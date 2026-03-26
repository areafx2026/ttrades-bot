const Database = require('better-sqlite3');
const db = new Database('./data/trades.db');

const newCols = [
  ['entry_distance_pips', 'REAL'],
  ['stop_pips', 'REAL'],
  ['session', 'TEXT'],
  ['weekday', 'INTEGER'],
  ['hold_duration_min', 'REAL'],
  ['h1_context', 'TEXT'],
  ['m15_setup', 'TEXT'],
  ['strength_score', 'REAL'],
  ['zone_status', 'TEXT'],
  ['fvg_present', 'INTEGER'],
  ['exhaustion_detected', 'INTEGER'],
  ['mae_pct_of_sl', 'REAL'],
  ['mfe_pct_of_tp', 'REAL'],
];

const existing = db.prepare("PRAGMA table_info(trades)").all().map(c => c.name);

for (const [col, type] of newCols) {
  if (!existing.includes(col)) {
    db.prepare(`ALTER TABLE trades ADD COLUMN ${col} ${type}`).run();
    console.log(`Added: ${col}`);
  } else {
    console.log(`Already exists: ${col}`);
  }
}

// Rename h1_setup to h1_context if needed
if (existing.includes('h1_setup') && !existing.includes('h1_context')) {
  console.log('Note: h1_setup exists — new trades will use h1_context');
}

console.log('Migration done');
db.close();

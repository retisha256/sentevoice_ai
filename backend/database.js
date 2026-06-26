const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Initialize database
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

// Create tables
db.serialize(() => {
  // Groups table
  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Members table
  db.run(`
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      balance REAL DEFAULT 0,
      total_savings REAL DEFAULT 0,
      total_loans REAL DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES groups(id)
    )
  `);

  // Transactions table
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER,
      type TEXT CHECK(type IN ('savings', 'loan', 'repayment', 'interest')),
      amount REAL NOT NULL,
      description TEXT,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(member_id) REFERENCES members(id)
    )
  `);

  // Insert default group if not exists
  db.run(`
    INSERT OR IGNORE INTO groups (id, name) VALUES (1, 'Default VSLA Group')
  `);
});

console.log('✅ Database initialized successfully');

module.exports = db;
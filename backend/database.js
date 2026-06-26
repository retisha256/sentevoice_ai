const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(
  path.join(__dirname, 'database.sqlite'),
  (err) => {
    if (err) {
      console.error('Database connection error:', err.message);
    } else {
      console.log('✅ Database initialized successfully');
    }
  }
);

db.serialize(() => {
  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Groups table
  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Members table (phone is UNIQUE now)
  db.run(`
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
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
      member_id INTEGER NOT NULL,
      type TEXT CHECK(type IN ('savings', 'loan', 'repayment', 'interest')),
      amount REAL NOT NULL,
      description TEXT,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(member_id) REFERENCES members(id)
    )
  `);

  // Default group
  db.run(`
    INSERT OR IGNORE INTO groups (id, name)
    VALUES (1, 'Default VSLA Group')
  `);

  // Add index for faster lookup
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_members_phone
    ON members(phone)
  `);
});

module.exports = db;
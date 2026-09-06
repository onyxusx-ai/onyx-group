import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class TestStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new TestStatement(this.database, this.sql, values);
  }

  first(column) {
    const row = this.database.prepare(this.sql).get(...this.values);
    if (column) return row?.[column] ?? null;
    return row || null;
  }

  all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.values) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
      },
    };
  }
}

export class TestD1 {
  constructor(path = ':memory:') {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON');
  }

  migrate(path) {
    this.database.exec(fs.readFileSync(path, 'utf8'));
  }

  prepare(sql) {
    return new TestStatement(this.database, sql);
  }

  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

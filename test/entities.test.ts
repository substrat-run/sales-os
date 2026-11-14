import { describe, expect, it } from 'vitest';
import { salesEntities } from '../src/entities.js';
import { salesModel } from '../src/model.js';
import { salesMigrations } from '../src/migrations.js';
import { salesManifest } from '../src/manifest.js';

// ============================================================================
// The registry and the migration journal are TWO DESCRIPTIONS OF ONE SCHEMA.
// Nothing derives one from the other, so nothing stops them drifting: rename a
// column in the journal and the registry goes stale while `tsc` stays green.
// This is the check that makes that a red build.
// ============================================================================

const journalSql = salesMigrations.map((m) => m.sql).join('\n');

/** The columns each `CREATE TABLE` actually leaves behind, plus any `ADD COLUMN`. */
function columnsFromJournal(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const [, table, body] of journalSql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
  )) {
    if (!table || !body) continue;
    const cols = new Set<string>();
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('--') || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const name = /^([a-z_][a-z0-9_]*)\b/i.exec(line)?.[1];
      if (name) cols.add(name);
    }
    tables.set(table, cols);
  }
  for (const [, table, col] of journalSql.matchAll(/ALTER TABLE ([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+([a-z_][a-z0-9_]*)/gi)) {
    if (table && col) tables.get(table)?.add(col);
  }
  return tables;
}

describe('the registry agrees with the migration journal', () => {
  const journal = columnsFromJournal();

  it('parsed the journal at all', () => {
    // A comparison that silently parsed nothing would pass everything under it.
    expect(journal.size).toBe(16);
    expect(journal.get('sales_companies')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(salesEntities)) {
    it(`${name} → ${entity.table}: the declared fields ARE the table's columns`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('leaves the raw import rows out — a table, not an entity', () => {
    expect(journal.has('sales_import_rows')).toBe(true);
    expect(Object.values(salesEntities).map((e) => e.table)).not.toContain('sales_import_rows');
  });
});

describe('the declared model and the manifest agree', () => {
  it('emits every declared entity', () => {
    expect(Object.keys(salesModel.entities).sort()).toEqual(Object.keys(salesEntities).sort());
  });

  it('declares every personal-data column erasable, so an event payload can never carry it', () => {
    expect(salesEntities.contact.erasable).toEqual(['name', 'email', 'phone']);
    expect(salesEntities.interaction.erasable).toEqual(['summary', 'customer_quote']);
    expect(salesEntities.member.erasable).toEqual(['display_name', 'email']);
    expect(salesEntities.invite.erasable).toEqual(['email']);
  });

  it('announces every mutation: the manifest lists the events the operations declare', () => {
    const types = salesManifest.events.emits.map((e) => e.type);
    expect(types).toContain('sales.company-created');
    expect(types).toContain('sales.opportunity-stage-changed');
    expect(types).toContain('sales.knowledge-approved');
    expect(types).toContain('sales.import-completed');
  });
});

import process from 'node:process'
import { constants, DatabaseSync } from 'node:sqlite'

// The MCP's SQL, enforced by SQLite itself. Run as a child process (see reader.ts), so a runaway
// query can be killed: node:sqlite is synchronous and cannot be interrupted.

// Introspection pragmas, read-only whatever their argument
const readablePragmas: ReadonlySet<string> = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
])

// A read-only connection that can only read: no write, transaction, ATTACH (which VACUUM and
// VACUUM INTO also go through, VACUUM INTO writing a new file even on a read-only connection),
// extension or writable pragma. Every operation not listed is denied.
export const openReadOnly = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path, {
    readOnly: true,
    defensive: true,
    timeout: 5000,
    // No ATTACH; a string or blob of 16 MiB at most
    limits: { attach: 0, length: 16 * 1024 * 1024 },
  })
  db.exec('PRAGMA query_only = ON')
  db.setAuthorizer((action, arg1, arg2) => {
    switch (action) {
      case constants.SQLITE_SELECT:
      case constants.SQLITE_READ:
      case constants.SQLITE_RECURSIVE: {
        return constants.SQLITE_OK
      }
      case constants.SQLITE_FUNCTION: {
        return arg2?.toLowerCase() === 'load_extension'
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK
      }
      case constants.SQLITE_PRAGMA: {
        return readablePragmas.has(arg1?.toLowerCase() ?? '')
          ? constants.SQLITE_OK
          : constants.SQLITE_DENY
      }
      default: {
        return constants.SQLITE_DENY
      }
    }
  })
  return db
}

export type Outcome =
  | { readonly rows: ReadonlyArray<Record<string, unknown>>; readonly total: number }
  | { readonly error: string }

// The rows kept, as JSON: the app reads the whole answer in memory
const MAX_BYTES = 16 * 1024 * 1024

// What may follow the end of a statement without starting another: whitespace, semicolons, comments
const gap = /^(?:\s|;|--[^\n]*|\/\*[\s\S]*?\*\/)*$/u

// Runs exactly one statement, keeping its first `maxRows` rows and counting the rest, refused past
// MAX_BYTES. SQLite compiles the first statement of a string and ignores the rest: anything after
// it but a gap is refused rather than silently dropped.
export const runStatement = (db: DatabaseSync, statement: string, maxRows: number): Outcome => {
  try {
    const prepared = db.prepare(statement)
    if (!gap.test(statement.slice(prepared.sourceSQL.length))) {
      return { error: 'Only one statement per query.' }
    }
    const rows: Array<Record<string, unknown>> = []
    let total = 0
    let bytes = 0
    for (const row of prepared.iterate()) {
      if (total < maxRows) {
        bytes += JSON.stringify(row).length
        if (bytes > MAX_BYTES) {
          return { error: 'The result is over 16 MB: select fewer rows or columns.' }
        }
        rows.push(row)
      }
      total += 1
    }
    return { rows, total }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// node src/read-only.ts <statement> <maxRows>, on DATABASE_PATH: prints the outcome as JSON
if (import.meta.main) {
  const db = openReadOnly(process.env.DATABASE_PATH ?? '')
  const outcome = runStatement(db, process.argv[2] ?? '', Number(process.argv[3]))
  process.stdout.write(JSON.stringify(outcome))
}

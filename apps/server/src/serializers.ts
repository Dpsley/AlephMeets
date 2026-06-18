export function camelizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  )
}

export function camelizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(camelizeRow)
}

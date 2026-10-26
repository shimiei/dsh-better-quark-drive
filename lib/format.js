/**
 * Small formatting helpers: the CLI hands back raw JSON with names that vary
 * between endpoints, and a model reads faster with compact tables than with
 * pretty-printed objects.
 */

export function formatBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = n / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

export function formatTime(value) {
  if (value === undefined || value === null || value === '') return ''
  const numeric = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  if (!Number.isFinite(numeric)) return String(value)
  const date = new Date(numeric)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** First defined key wins; keeps us tolerant to field-name drift. */
export function pick(source, keys, fallback = '') {
  if (!source || typeof source !== 'object') return fallback
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return fallback
}

export function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function truncate(text, max = 48) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Render a markdown table; returns '' for no rows. */
export function table(headers, rows) {
  if (!rows || rows.length === 0) return ''
  const head = `| ${headers.map(escapeCell).join(' | ')} |`
  const divider = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.map((cell) => escapeCell(cell)).join(' | ')} |`)
  return [head, divider, ...body].join('\n')
}

/** Human label for the CLI's `--expired-type` values. */
export function expireLabel(expiredType) {
  const map = { 1: '永久有效', 2: '1 天', 3: '7 天', 4: '30 天', 5: '60 天', 6: '100 天', 7: '180 天' }
  return map[String(expiredType)] ?? `类型 ${expiredType}`
}

/** Map a human "days" value onto the CLI's enum. */
export function expireTypeForDays(days, fallbackDays = 7) {
  const wanted = Number.isFinite(Number(days)) ? Number(days) : fallbackDays
  const exact = { 0: 1, 1: 2, 7: 3, 30: 4, 60: 5, 100: 6, 180: 7 }
  if (exact[wanted] !== undefined) return exact[wanted]
  // Anything else: pick the smallest bucket that covers the request.
  const ladder = [1, 2, 7, 30, 60, 100, 180]
  const bucket = ladder.find((d) => d >= wanted)
  return bucket === undefined ? 7 : exact[bucket]
}

export function urlTypeLabel(urlType) {
  return String(urlType) === '2' ? '私密链接（带提取码）' : '公开链接'
}

/** Normalise the many shapes a CLI file entry can take. */
export function normalizeEntry(entry) {
  const fid = String(pick(entry, ['fid', 'file_id', 'fileId', 'id'], ''))
  const name = String(pick(entry, ['file_name', 'fileName', 'name', 'title'], '(未命名)'))
  const size = pick(entry, ['size', 'file_size', 'fileSize', 'bytes'], '')
  const isDir = Boolean(pick(entry, ['dir', 'is_dir', 'isDir', 'folder'], false))
  const updated = pick(entry, ['updated_at', 'updatedAt', 'mtime', 'modified_at', 'create_time'], '')
  return { fid, name, size, isDir, updated }
}

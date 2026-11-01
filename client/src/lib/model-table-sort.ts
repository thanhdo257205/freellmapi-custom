import type { ModelGroupRow, Row } from '@/lib/routing'
import type { SortDirection, SortState } from '@/lib/table-sort'

export type ModelSortCol =
  | 'rank'
  | 'model'
  | 'reliability'
  | 'speed'
  | 'intelligence'
  | 'guardrails'
  | 'score'
  | 'on'

export const MODEL_SORT_COLS: readonly ModelSortCol[] = [
  'rank',
  'model',
  'reliability',
  'speed',
  'intelligence',
  'guardrails',
  'score',
  'on',
]

// Numeric / status columns sort descending first (highest / enabled first).
// Text / rank columns sort ascending first (A-Z, 1..N first).
const DESC_FIRST_COLS: readonly ModelSortCol[] = [
  'reliability',
  'speed',
  'intelligence',
  'guardrails',
  'score',
  'on',
]

export function nextModelSort(current: SortState<ModelSortCol>, col: ModelSortCol): SortState<ModelSortCol> {
  const descFirst = DESC_FIRST_COLS.includes(col)
  const firstDir: SortDirection = descFirst ? 'desc' : 'asc'
  const secondDir: SortDirection = descFirst ? 'asc' : 'desc'

  if (!current || current.column !== col) {
    return { column: col, direction: firstDir }
  }
  if (current.direction === firstDir) {
    return { column: col, direction: secondDir }
  }
  return null
}

function getGroupBestMember(members: Row[]): Row {
  if (members.length === 0) return {} as Row
  return members.reduce((b, m) => ((m.score ?? -1) > (b.score ?? -1) ? m : b), members[0])
}

export function getGroupSortValue(
  group: ModelGroupRow,
  col: ModelSortCol,
  rankByKey: ReadonlyMap<string, number>,
): number | string | null {
  switch (col) {
    case 'rank':
      return rankByKey.get(group.key) ?? 999999

    case 'model':
      return group.label.toLowerCase()

    case 'reliability': {
      const measured = group.members.filter(m => (m.totalRequests ?? 0) > 0 && m.reliability !== undefined)
      if (measured.length === 0) return null
      return Math.max(...measured.map(m => m.reliability as number))
    }

    case 'speed': {
      const measured = group.members.filter(m => (m.totalRequests ?? 0) > 0 && m.speed !== undefined)
      if (measured.length === 0) return null
      return Math.max(...measured.map(m => m.speed as number))
    }

    case 'intelligence': {
      const vals = group.members.map(m => m.intelligence).filter((v): v is number => v !== undefined)
      if (vals.length === 0) return null
      return Math.max(...vals)
    }

    case 'guardrails': {
      const best = getGroupBestMember(group.members)
      return (best.headroom ?? 1) * (best.rateLimit ?? 1)
    }

    case 'score': {
      const best = getGroupBestMember(group.members)
      return best.score ?? null
    }

    case 'on': {
      const anyEnabled = group.members.some(m => m.enabled)
      return anyEnabled ? 1 : 0
    }
  }
}

export function sortModelGroups(
  groups: ModelGroupRow[],
  sort: SortState<ModelSortCol>,
  rankByKey: ReadonlyMap<string, number>,
): ModelGroupRow[] {
  if (!sort) return groups

  const sign = sort.direction === 'asc' ? 1 : -1

  return groups.slice().sort((a, b) => {
    const av = getGroupSortValue(a, sort.column, rankByKey)
    const bv = getGroupSortValue(b, sort.column, rankByKey)

    // Nulls stay last regardless of direction
    if (av === null && bv === null) {
      return (rankByKey.get(a.key) ?? 0) - (rankByKey.get(b.key) ?? 0)
    }
    if (av === null) return 1
    if (bv === null) return -1

    if (typeof av === 'number' && typeof bv === 'number') {
      if (av !== bv) return sign * (av - bv)
    } else {
      const cmp = String(av).localeCompare(String(bv))
      if (cmp !== 0) return sign * cmp
    }

    // Tie-breaker: original chain rank
    return (rankByKey.get(a.key) ?? 0) - (rankByKey.get(b.key) ?? 0)
  })
}

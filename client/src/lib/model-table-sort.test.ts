import { describe, expect, it } from 'vitest'
import {
  nextModelSort,
  sortModelGroups,
} from './model-table-sort'
import type { ModelGroupRow, Row } from './routing'

function makeRow(partial: Partial<Row>): Row {
  return {
    modelDbId: 1,
    priority: 1,
    effectivePriority: 1,
    penalty: 0,
    rateLimitHits: 0,
    enabled: true,
    platform: 'test',
    modelId: 'test-model',
    displayName: 'Test Model',
    intelligenceRank: 1,
    speedRank: 1,
    sizeLabel: '',
    rpmLimit: null,
    rpdLimit: null,
    monthlyTokenBudget: '0',
    contextWindow: 1000,
    supportsVision: false,
    supportsTools: false,
    ...partial,
  } as Row
}

describe('model-table-sort', () => {
  describe('nextModelSort', () => {
    it('starts desc for score and cycles to asc then null', () => {
      const s1 = nextModelSort(null, 'score')
      expect(s1).toEqual({ column: 'score', direction: 'desc' })

      const s2 = nextModelSort(s1, 'score')
      expect(s2).toEqual({ column: 'score', direction: 'asc' })

      const s3 = nextModelSort(s2, 'score')
      expect(s3).toBeNull()
    })

    it('starts asc for model name and cycles to desc then null', () => {
      const s1 = nextModelSort(null, 'model')
      expect(s1).toEqual({ column: 'model', direction: 'asc' })

      const s2 = nextModelSort(s1, 'model')
      expect(s2).toEqual({ column: 'model', direction: 'desc' })

      const s3 = nextModelSort(s2, 'model')
      expect(s3).toBeNull()
    })

    it('switches column immediately to default direction of new column', () => {
      const s1 = nextModelSort(null, 'model')
      expect(s1).toEqual({ column: 'model', direction: 'asc' })

      const s2 = nextModelSort(s1, 'score')
      expect(s2).toEqual({ column: 'score', direction: 'desc' })
    })
  })

  describe('getGroupSortValue and sortModelGroups', () => {
    const groupA: ModelGroupRow = {
      key: 'grp-a',
      label: 'Alpha Model',
      members: [
        makeRow({
          modelDbId: 1,
          score: 0.65,
          totalRequests: 10,
          reliability: 0.95,
          speed: 0.8,
          intelligence: 0.9,
          enabled: true,
        }),
      ],
    }

    const groupB: ModelGroupRow = {
      key: 'grp-b',
      label: 'Beta Model',
      members: [
        makeRow({
          modelDbId: 2,
          score: 0.75,
          totalRequests: 20,
          reliability: 0.99,
          speed: 0.9,
          intelligence: 0.99,
          enabled: false,
        }),
      ],
    }

    const groupNoData: ModelGroupRow = {
      key: 'grp-c',
      label: 'Gamma Model',
      members: [
        makeRow({
          modelDbId: 3,
          score: undefined,
          totalRequests: 0,
          reliability: 0.5,
          speed: 0.6,
          intelligence: 0.7,
          enabled: true,
        }),
      ],
    }

    const rankByKey = new Map([
      ['grp-a', 1],
      ['grp-b', 2],
      ['grp-c', 3],
    ])

    it('sorts by model name asc and desc', () => {
      const asc = sortModelGroups([groupB, groupA, groupNoData], { column: 'model', direction: 'asc' }, rankByKey)
      expect(asc.map(g => g.key)).toEqual(['grp-a', 'grp-b', 'grp-c'])

      const desc = sortModelGroups([groupA, groupB, groupNoData], { column: 'model', direction: 'desc' }, rankByKey)
      expect(desc.map(g => g.key)).toEqual(['grp-c', 'grp-b', 'grp-a'])
    })

    it('sorts by score desc putting nulls at the end', () => {
      const desc = sortModelGroups([groupA, groupNoData, groupB], { column: 'score', direction: 'desc' }, rankByKey)
      expect(desc.map(g => g.key)).toEqual(['grp-b', 'grp-a', 'grp-c'])

      const asc = sortModelGroups([groupA, groupNoData, groupB], { column: 'score', direction: 'asc' }, rankByKey)
      expect(asc.map(g => g.key)).toEqual(['grp-a', 'grp-b', 'grp-c'])
    })

    it('sorts by reliability putting unmeasured (0 requests) at the end', () => {
      const desc = sortModelGroups([groupNoData, groupA, groupB], { column: 'reliability', direction: 'desc' }, rankByKey)
      expect(desc.map(g => g.key)).toEqual(['grp-b', 'grp-a', 'grp-c'])
    })

    it('sorts by on/off status', () => {
      const desc = sortModelGroups([groupB, groupA, groupNoData], { column: 'on', direction: 'desc' }, rankByKey)
      // groupA and groupNoData are enabled, groupB is disabled
      expect(desc[2].key).toBe('grp-b')
    })
  })
})

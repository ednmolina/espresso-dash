import { beforeEach, describe, expect, it, vi } from 'vitest'

const DELETE = { __deleteField: true }
const mocks = vi.hoisted(() => ({
  addDoc: vi.fn(async () => ({ id: 'new' })),
  updateDoc: vi.fn(async () => {}),
  getDocsFromServer: vi.fn(),
}))

vi.mock('../firestore', () => ({ db: {} }))
vi.mock('firebase/firestore', () => ({
  addDoc: mocks.addDoc,
  updateDoc: mocks.updateDoc,
  getDocsFromServer: mocks.getDocsFromServer,
  deleteField: () => ({ __deleteField: true }),
  collection: (db, name) => ({ collection: name }),
  doc: (db, name, id) => ({ collection: name, id }),
}))

const {
  PH_MAX,
  PH_MIN,
  addShotToFirestore,
  buildDashboardPayload,
  buildExperimentPayload,
  parsePhInput,
  updateShotCellInFirestore,
} = await import('../dashboardData')

function shot(i, over = {}) {
  return {
    id: `s${i}`,
    date: `2025-02-${String(i + 1).padStart(2, '0')}`,
    roaster: 'Onyx',
    region: i % 2 ? 'Huila' : 'Gedeo',
    continent: 'Africa',
    variety: 'Heirloom',
    processingTechnique: '',
    roast: '',
    avgGrind: '',
    grindSetting: `${8 + (i % 5)}${'ABCDE'[i % 5]}`,
    dose: 18,
    yieldGrams: 36,
    time: 28,
    tempC: 28,
    brix: 10,
    ph: null,
    tds: 9 + (i % 4) * 0.2,
    extraction: 18 + (i % 6),
    rating: i % 3,
    ...over,
  }
}
const shots = (n, over) => Array.from({ length: n }, (_, i) => shot(i, typeof over === 'function' ? over(i) : over))
const baseFields = { entry_date: '2025-03-01', roaster: 'Onyx', temp_c: '28', brix: '10', dose: '18', yield_grams: '36', shot_time: '28' }

beforeEach(() => {
  mocks.addDoc.mockClear()
  mocks.updateDoc.mockClear()
})

describe('parsePhInput', () => {
  it('validates pH', () => {
    expect(PH_MIN).toBe(3.5)
    expect(PH_MAX).toBe(8)
    expect(parsePhInput('')).toEqual({ value: null, error: null })
    expect(parsePhInput('   ')).toEqual({ value: null, error: null })
    expect(parsePhInput(null)).toEqual({ value: null, error: null })
    expect(parsePhInput('5.4')).toEqual({ value: 5.4, error: null })
    expect(parsePhInput(5.4)).toEqual({ value: 5.4, error: null })
    expect(parsePhInput('abc')).toEqual({ value: null, error: 'pH must be a number' })
    expect(parsePhInput('9').error).toBe('pH must be between 3.5 and 8.0')
    expect(parsePhInput('3.4').error).toBe('pH must be between 3.5 and 8.0')
    expect(parsePhInput('3.5').error).toBeNull()
    expect(parsePhInput('8').error).toBeNull()
  })
})

describe('defaults', () => {
  it('never carries a pH forward or defaults it to 5.2', () => {
    expect(buildDashboardPayload([]).defaults.latest_values.ph).toBe('')
    expect(buildDashboardPayload(shots(3, { ph: 5.4 })).defaults.latest_values.ph).toBe('')
  })
})

describe('writes', () => {
  it('omits ph when blank and writes it when valid', async () => {
    await addShotToFirestore({ shots: [], fields: { ...baseFields, ph: '' }, carryForward: false, carryShot: false })
    expect(mocks.addDoc).toHaveBeenCalledTimes(1)
    const [target, payload] = mocks.addDoc.mock.calls[0]
    expect(target).toEqual({ collection: 'shots' })
    expect('ph' in payload).toBe(false)

    await addShotToFirestore({ shots: [], fields: { ...baseFields, ph: '5.4' }, carryForward: false, carryShot: false })
    expect(mocks.addDoc.mock.calls[1][1].ph).toBe(5.4)
  })

  it('throws on a bad pH without writing', async () => {
    await expect(addShotToFirestore({ shots: [], fields: { ...baseFields, ph: '9' }, carryForward: false, carryShot: false }))
      .rejects.toThrow('pH must be between 3.5 and 8.0')
    await expect(addShotToFirestore({ shots: [], fields: { ...baseFields, ph: 'x' }, carryForward: false, carryShot: false }))
      .rejects.toThrow('pH must be a number')
    expect(mocks.addDoc).not.toHaveBeenCalled()
  })

  it('removes pH with deleteField on a blank cell edit', async () => {
    const list = shots(3, { ph: 5.4 })
    await updateShotCellInFirestore({ shots: list, rowId: 's1', column: 'pH', value: '' })
    const [ref, payload] = mocks.updateDoc.mock.calls[0]
    expect(ref).toEqual({ collection: 'shots', id: 's1' })
    expect(payload.ph).toEqual(DELETE)

    await updateShotCellInFirestore({ shots: list, rowId: 's1', column: 'pH', value: '5.6' })
    expect(mocks.updateDoc.mock.calls[1][1].ph).toBe(5.6)

    await updateShotCellInFirestore({ shots: list, rowId: 's1', column: 'Notes', value: 'hi' })
    expect(mocks.updateDoc.mock.calls[2][1].ph).toBe(5.4)

    await expect(updateShotCellInFirestore({ shots: list, rowId: 's1', column: 'pH', value: '12' }))
      .rejects.toThrow('pH must be between 3.5 and 8.0')
    expect(mocks.updateDoc).toHaveBeenCalledTimes(3)
  })

  it('does not touch ph when editing another cell of a shot without pH', async () => {
    await updateShotCellInFirestore({ shots: shots(3), rowId: 's1', column: 'Notes', value: 'x' })
    expect('ph' in mocks.updateDoc.mock.calls[0][1]).toBe(false)
  })
})

describe('buildExperimentPayload', () => {
  it('is unavailable under 8 shots', () => {
    expect(buildExperimentPayload(shots(7), {}).available).toBe(false)
  })

  it('has no fabricated metrics and uses the forecast model for the sweep', () => {
    const payload = buildExperimentPayload(shots(24), {})
    expect(payload.available).toBe(true)
    for (const key of ['extraction_r2', 'extraction_mae', 'rating_balanced_accuracy']) {
      expect(payload.metrics).not.toHaveProperty(key)
    }
    expect(payload.metrics.rows).toBe(24)
    expect(payload.metrics.backtest).toEqual({
      mae: expect.any(Number), baselineMae: expect.any(Number), within1: expect.any(Number), evaluated: 16,
    })
    expect(payload.grind_sweep).toHaveLength(13)
    expect(Object.keys(payload.grind_sweep[0])).toEqual(expect.arrayContaining([
      'Grind Index', 'Grind Setting', 'Grind µm (est.)', 'Predicted Extraction', 'Low', 'High', 'Great Probability', 'Good Probability',
    ]))
    expect(payload.grind_sweep[0]['Grind µm (est.)']).toBeNull()
    expect(payload.best_candidates).toHaveLength(8)
    const dist = payload.best_candidates.map((r) => Math.abs(r['Predicted Extraction'] - 20))
    expect(dist).toEqual([...dist].sort((a, b) => a - b))
    expect(payload.prediction.great_probability + payload.prediction.good_probability).toBeLessThanOrEqual(1)
    expect(payload).toHaveProperty('similar_successes')
    expect(payload).toHaveProperty('target_leaders')
    expect(payload.prediction).toHaveProperty('novelty_flag')
  })

  it('reports no backtest when too few shots are evaluable', () => {
    expect(buildExperimentPayload(shots(10), {}).metrics.backtest).toBeNull()
  })

  it('ignores pH in similarity when either side is missing', () => {
    const noPh = shots(16)
    const base = buildExperimentPayload(noPh, {}).similar_successes
    expect(base.length).toBeGreaterThan(0)
    expect(buildExperimentPayload(noPh, { ph: '5.2' }).similar_successes).toEqual(base)

    const withPh = shots(16, (i) => ({ ph: 5 + (i % 5) * 0.2 }))
    expect(buildExperimentPayload(withPh, { ph: '' }).similar_successes).toEqual(base)
    expect(buildExperimentPayload(withPh, { ph: '5.8' }).similar_successes).not.toEqual(base)
  })
})

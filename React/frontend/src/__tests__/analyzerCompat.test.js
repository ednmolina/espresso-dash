import { describe, expect, it } from 'vitest'
import { layerOf, mergeErase, previewSrc, normalizeSummary, histogramKind } from '../analyzerCompat'

describe('layerOf', () => {
  it('returns null without a result or for the original photo', () => {
    expect(layerOf(null, 'clusters')).toBeNull()
    expect(layerOf({}, 'original')).toBeNull()
    expect(layerOf({}, 'clusters')).toBeNull()
  })

  it('prefers the on-device image layer over base64 strings', () => {
    const image = { width: 2, height: 2 } // stands in for an ImageBitmap
    const result = { cluster_layer: image, cluster_layer_b64: 'abc', threshold_layer: image }
    expect(layerOf(result, 'clusters')).toBe(image)
    expect(layerOf(result, 'threshold')).toBe(image)
  })

  it('falls back to the new then the old cloud layers', () => {
    expect(layerOf({ cluster_layer_b64: 'new', cluster_overlay_b64: 'old' }, 'clusters')).toBe('new')
    expect(layerOf({ cluster_overlay_b64: 'old' }, 'clusters')).toBe('old')
    expect(layerOf({ threshold_layer_b64: 'new', threshold_overlay_b64: 'old' }, 'threshold')).toBe('new')
    expect(layerOf({ threshold_overlay_b64: 'old' }, 'threshold')).toBe('old')
  })
})

describe('mergeErase', () => {
  const prevLocal = {
    cluster_layer: { id: 'old' },
    threshold_layer: { id: 'thr' },
    nclusters: 3,
    summary: { cluster_count: 3 },
    particles: { id: [1, 2, 3], surface: [10, 20, 30] },
  }

  it('carries the new cluster_layer and keeps the threshold layer', () => {
    const next = { cluster_layer: { id: 'new' }, nclusters: 2, summary: { cluster_count: 2 }, removed_ids: [2] }
    const merged = mergeErase(prevLocal, next, [2])
    expect(merged.cluster_layer).toBe(next.cluster_layer)
    expect(merged.threshold_layer).toBe(prevLocal.threshold_layer)
    expect(merged.nclusters).toBe(2)
    expect(merged.summary).toEqual({ cluster_count: 2 })
    expect(merged.particles).toEqual({ id: [1, 3], surface: [10, 30] })
  })

  it('keeps the previous cluster_layer when the response has none', () => {
    const merged = mergeErase(prevLocal, { nclusters: 3 }, [])
    expect(merged.cluster_layer).toBe(prevLocal.cluster_layer)
  })

  it('still merges cloud base64 layers', () => {
    const merged = mergeErase({ cluster_layer_b64: 'a', nclusters: 4 }, { cluster_layer_b64: 'b', nclusters: 3, summary: null }, [])
    expect(merged.cluster_layer_b64).toBe('b')
    expect(merged.cluster_layer).toBeUndefined()
    expect(merged.summary).toBeNull()
  })

  it('uses the old opaque composite as a last resort', () => {
    const merged = mergeErase({}, { cluster_overlay_b64: 'old' }, [])
    expect(merged.cluster_layer_b64).toBe('old')
  })
})

describe('other helpers keep working', () => {
  it('previewSrc builds a data URL only when the upload carries an image', () => {
    expect(previewSrc({})).toBeNull()
    expect(previewSrc({ image_b64: 'xx', image_mime: 'image/jpeg' })).toBe('data:image/jpeg;base64,xx')
  })

  it('normalizeSummary marks missing dv50 as legacy', () => {
    expect(normalizeSummary({ diameter_mean_mm: 0.4 }).legacy).toBe(true)
    expect(normalizeSummary({ dv50_mm: 0.4 }).legacy).toBe(false)
  })

  it('histogramKind distinguishes series and png', () => {
    expect(histogramKind({ edges: [1, 2], series: [] })).toBe('series')
    expect(histogramKind({ histogram_b64: 'x' })).toBe('png')
    expect(histogramKind({})).toBe('none')
  })
})

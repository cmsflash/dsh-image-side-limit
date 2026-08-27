import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { budgetForSideCap, clampPolicyToSide, projectDimensions } from '../src/policy.ts'

const ROUTE_BUDGET = 2048 * 2048
const MAX_SIDE = 2000
const policy = { maxPixels: ROUTE_BUDGET, maxBytes: 1024 * 1024 }

/** Dimensions observed in real DSH session logs on this machine, plus adversarial ratios. */
const SOURCES: ReadonlyArray<readonly [number, number, string]> = [
  [2048, 473, 'GCSX banner that broke the session'],
  [2048, 1185, 'GLM rollouts screenshot'],
  [3840, 2160, '4K screenshot'],
  [3728, 2078, 'Chrome tab-group capture'],
  [2596, 1504, 'GCS viz capture'],
  [3000, 300, 'extreme 10:1 strip'],
  [400, 3000, 'tall portrait'],
  [2001, 2001, 'one pixel over on both sides'],
  [2001, 1, 'degenerate one-pixel-tall strip'],
  [1, 2001, 'degenerate one-pixel-wide strip'],
  [12000, 5, 'pathological 2400:1 ratio'],
]

describe('projectDimensions', () => {
  it('returns the source unchanged when it already fits the budget', () => {
    assert.deepEqual(projectDimensions(1446, 837, ROUTE_BUDGET), { width: 1446, height: 837 })
  })

  it('never exceeds the pixel budget it is given', () => {
    for (const [width, height, label] of SOURCES) {
      for (const budget of [ROUTE_BUDGET, 1_000_000, 923_828, 640_000, 10_000, 1]) {
        const projected = projectDimensions(width, height, budget)
        assert.ok(
          projected.width * projected.height <= Math.max(budget, 1),
          `${label} at budget ${budget}: ${projected.width}x${projected.height} exceeds budget`,
        )
        assert.ok(projected.width >= 1 && projected.height >= 1, `${label}: produced a zero dimension`)
        assert.ok(Number.isInteger(projected.width) && Number.isInteger(projected.height), `${label}: non-integer`)
      }
    }
  })

  it('preserves orientation', () => {
    const wide = projectDimensions(3000, 300, 100_000)
    assert.ok(wide.width > wide.height)
    const tall = projectDimensions(300, 3000, 100_000)
    assert.ok(tall.height > tall.width)
  })
})

describe('budgetForSideCap', () => {
  it('produces a budget whose projection satisfies the cap', () => {
    for (const [width, height, label] of SOURCES) {
      const budget = budgetForSideCap(width, height, MAX_SIDE)
      const projected = projectDimensions(width, height, budget)
      assert.ok(
        Math.max(projected.width, projected.height) <= MAX_SIDE,
        `${label}: ${projected.width}x${projected.height} exceeds ${MAX_SIDE}`,
      )
      assert.ok(budget >= 1, `${label}: non-positive budget`)
    }
  })

  it('leaves a source already within the cap at its own pixel count', () => {
    assert.equal(budgetForSideCap(1446, 837, MAX_SIDE), 1446 * 837)
  })

  it('holds for a swept range of aspect ratios', () => {
    for (let width = 2001; width <= 6000; width += 137) {
      for (const height of [1, 7, 300, 1200, width]) {
        const budget = budgetForSideCap(width, height, MAX_SIDE)
        const projected = projectDimensions(width, height, budget)
        assert.ok(
          Math.max(projected.width, projected.height) <= MAX_SIDE,
          `${width}x${height}: projected ${projected.width}x${projected.height}`,
        )
      }
    }
  })
})

describe('clampPolicyToSide', () => {
  it('returns the identical policy object when no clamping is needed', () => {
    const source = { width: 1446, height: 837 }
    assert.equal(clampPolicyToSide(source, policy, MAX_SIDE), policy)
  })

  it('never relaxes the byte budget', () => {
    const clamped = clampPolicyToSide({ width: 3840, height: 2160 }, policy, MAX_SIDE)
    assert.equal(clamped.maxBytes, policy.maxBytes)
  })

  it('never raises maxPixels above the route budget', () => {
    for (const [width, height] of SOURCES) {
      const clamped = clampPolicyToSide({ width, height }, policy, MAX_SIDE)
      assert.ok(clamped.maxPixels <= policy.maxPixels)
    }
  })

  it('brings every oversized real-world source within the cap', () => {
    for (const [width, height, label] of SOURCES) {
      const clamped = clampPolicyToSide({ width, height }, policy, MAX_SIDE)
      const projected = projectDimensions(width, height, clamped.maxPixels)
      assert.ok(
        Math.max(projected.width, projected.height) <= MAX_SIDE,
        `${label}: ${projected.width}x${projected.height}`,
      )
    }
  })

  it('fixes the ratios a total-pixel budget provably cannot express', () => {
    // 3000x300 is only 900,000 pixels — far under a 2048^2 budget — yet 3000px
    // wide. No pixel budget that keeps ordinary screenshots legible fixes it.
    const strip = { width: 3000, height: 300 }
    const unclamped = projectDimensions(strip.width, strip.height, ROUTE_BUDGET)
    assert.equal(unclamped.width, 3000, 'precondition: the route budget leaves the strip untouched')

    const clamped = clampPolicyToSide(strip, policy, MAX_SIDE)
    const projected = projectDimensions(strip.width, strip.height, clamped.maxPixels)
    assert.ok(projected.width <= MAX_SIDE)
  })

  it('is idempotent', () => {
    const source = { width: 3840, height: 2160 }
    const once = clampPolicyToSide(source, policy, MAX_SIDE)
    const twice = clampPolicyToSide(source, once, MAX_SIDE)
    assert.deepEqual(twice, once)
  })

  it('keeps a distinct cache identity only when it changes the budget', () => {
    // The backend derives its variant id from maxPixels + maxBytes, so an
    // unchanged policy must stay byte-identical or cached versions are orphaned.
    const untouched = clampPolicyToSide({ width: 1446, height: 837 }, policy, MAX_SIDE)
    assert.deepEqual(untouched, policy)

    const changed = clampPolicyToSide({ width: 2048, height: 473 }, policy, MAX_SIDE)
    assert.notDeepEqual(changed, policy)
  })
})

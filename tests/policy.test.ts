import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { longEdgeDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { clampTargetToSide } from '../src/policy.ts'
import { MAX_BYTES, routeTarget } from './route-target.ts'

const MAX_SIDE = 2000

/** The dimensions the store produces for a target: a long-edge resize, never enlarging. */
function produced(width: number, height: number, target: ImageRequestTarget): { width: number, height: number } {
  return longEdgeDimensions(width, height, width >= height ? target.width : target.height)
}

/** Dimensions observed in real DSH session logs on this machine, plus adversarial ratios. */
const SOURCES: ReadonlyArray<readonly [number, number, string]> = [
  [2048, 473, 'GCSX banner that broke the session'],
  [3248, 750, 'the same banner at its original paste size'],
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

describe('clampTargetToSide', () => {
  it('returns the identical target object when the route target already fits', () => {
    const target = routeTarget(1446, 837)
    assert.equal(clampTargetToSide({ width: 1446, height: 837 }, target, MAX_SIDE), target)
  })

  it('brings every oversized real-world source within the cap', () => {
    for (const [width, height, label] of SOURCES) {
      const clamped = clampTargetToSide({ width, height }, routeTarget(width, height), MAX_SIDE)
      const result = produced(width, height, clamped)
      assert.ok(
        Math.max(result.width, result.height) <= MAX_SIDE,
        `${label}: ${result.width}x${result.height} exceeds ${MAX_SIDE}`,
      )
      assert.ok(result.width >= 1 && result.height >= 1, `${label}: produced a zero dimension`)
    }
  })

  it('fixes the ratios a total-pixel budget provably cannot express', () => {
    // 3000x300 is only 900,000 pixels — far under a 2048^2 budget — so the
    // route's own target leaves the strip 3000px wide.
    const target = routeTarget(3000, 300)
    assert.equal(produced(3000, 300, target).width, 3000, 'precondition: the route target leaves the strip untouched')
    const clamped = clampTargetToSide({ width: 3000, height: 300 }, target, MAX_SIDE)
    assert.ok(produced(3000, 300, clamped).width <= MAX_SIDE)
  })

  it('never relaxes the byte target', () => {
    const clamped = clampTargetToSide({ width: 3840, height: 2160 }, routeTarget(3840, 2160), MAX_SIDE)
    assert.equal(clamped.maxBytes, MAX_BYTES)
  })

  it('never enlarges a route target stricter than the cap', () => {
    for (const [width, height, label] of SOURCES) {
      const strict = routeTarget(width, height, 160_000)
      const clamped = clampTargetToSide({ width, height }, strict, MAX_SIDE)
      if (Math.max(produced(width, height, strict).width, produced(width, height, strict).height) <= MAX_SIDE) {
        assert.equal(clamped, strict, `${label}: a fitting target was replaced`)
      }
      assert.ok(clamped.width <= strict.width && clamped.height <= strict.height, `${label}: target was enlarged`)
    }
  })

  it('holds for a swept range of aspect ratios in both orientations', () => {
    for (let side = 2001; side <= 6000; side += 137) {
      for (const other of [1, 7, 300, 1200, side]) {
        for (const [width, height] of [[side, other], [other, side]] as const) {
          const clamped = clampTargetToSide({ width, height }, routeTarget(width, height), MAX_SIDE)
          const result = produced(width, height, clamped)
          assert.ok(Math.max(result.width, result.height) <= MAX_SIDE, `${width}x${height}: ${result.width}x${result.height}`)
        }
      }
    }
  })

  it('is idempotent', () => {
    const source = { width: 3840, height: 2160 }
    const once = clampTargetToSide(source, routeTarget(3840, 2160), MAX_SIDE)
    assert.deepEqual(clampTargetToSide(source, once, MAX_SIDE), once)
  })

  it('preserves aspect ratio within a pixel of the source', () => {
    const clamped = clampTargetToSide({ width: 3000, height: 300 }, routeTarget(3000, 300), MAX_SIDE)
    const result = produced(3000, 300, clamped)
    assert.ok(Math.abs(10 - result.width / result.height) / 10 < 0.02, `ratio drifted: ${result.width}x${result.height}`)
  })
})

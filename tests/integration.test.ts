/**
 * End-to-end checks against the real `LocalAttachmentStore`, real `sharp`
 * encoding, and a real temporary DSH_HOME. The unit tests exercise this
 * plugin's arithmetic; these exercise the claim that actually matters — that
 * bytes leaving `readImageRequest` decode to an image within the side cap.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { ImageAttachmentRef, ImageRequestPolicy } from '@deepseek-ai/dsh-attachment'
import { SideLimitedAttachmentStore } from '../src/index.ts'

const MAX_SIDE = 2000
const ROUTE_POLICY: ImageRequestPolicy = { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 }

/** Noise beats a flat fill: a solid image compresses so far that byte caps never bind. */
async function png(width: number, height: number): Promise<Uint8Array> {
  const channels = 3 as const
  const raw = Buffer.alloc(width * height * channels)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 256
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels } }).png().toBuffer())
}

let home: string
let plain: LocalAttachmentStore
let limited: SideLimitedAttachmentStore

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-side-limit-'))
  // Two independent roots: `ctx.attachments` is a single slot, so the stock
  // store and the subclass cannot both be provided on one context.
  plain = new LocalAttachmentStore(new Context(), { dshHome: join(home, 'plain') })
  limited = new SideLimitedAttachmentStore(new Context(), {
    dshHome: join(home, 'limited'),
    maxRequestImageSide: MAX_SIDE,
  })
})

after(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Store one image in both backends and return each backend's reference. */
async function save(width: number, height: number): Promise<{
  plainRef: ImageAttachmentRef
  limitedRef: ImageAttachmentRef
}> {
  const data = await png(width, height)
  const [plainRef, limitedRef] = await Promise.all([
    plain.saveImage({ data, mediaType: 'image/png', name: 'probe.png' }),
    limited.saveImage({ data, mediaType: 'image/png', name: 'probe.png' }),
  ])
  return { plainRef, limitedRef }
}

describe('SideLimitedAttachmentStore against the real backend', () => {
  it('keeps the stock store producing an oversized request version', async () => {
    // Establishes that the bug is real in this exact environment; without this
    // the next test could pass because nothing was ever oversized.
    const { plainRef } = await save(2048, 473)
    const version = await plain.readImageRequest(plainRef, ROUTE_POLICY)
    const decoded = await sharp(version.data).metadata()
    assert.equal(Math.max(decoded.width, decoded.height), 2048)
    assert.ok(Math.max(decoded.width, decoded.height) > MAX_SIDE)
  })

  it('caps the long edge of the decoded request bytes', async () => {
    const cases: ReadonlyArray<readonly [number, number, string]> = [
      [2048, 473, 'GCSX banner'],
      [2048, 1185, 'GLM screenshot'],
      [3000, 300, 'extreme 10:1 strip'],
      [400, 3000, 'tall portrait'],
      [2560, 1800, 'retina capture'],
    ]
    for (const [width, height, label] of cases) {
      const { limitedRef } = await save(width, height)
      const version = await limited.readImageRequest(limitedRef, ROUTE_POLICY)
      const decoded = await sharp(version.data).metadata()
      assert.ok(
        Math.max(decoded.width, decoded.height) <= MAX_SIDE,
        `${label}: decoded ${decoded.width}x${decoded.height} exceeds ${MAX_SIDE}`,
      )
      assert.equal(decoded.width, version.width, `${label}: reported width disagrees with bytes`)
      assert.equal(decoded.height, version.height, `${label}: reported height disagrees with bytes`)
      assert.ok(version.data.byteLength <= ROUTE_POLICY.maxBytes, `${label}: exceeded the byte budget`)
    }
  })

  it('leaves an image already within the cap byte-identical to the stock store', async () => {
    const { plainRef, limitedRef } = await save(1446, 837)
    const [stock, capped] = await Promise.all([
      plain.readImageRequest(plainRef, ROUTE_POLICY),
      limited.readImageRequest(limitedRef, ROUTE_POLICY),
    ])
    assert.equal(capped.variantId, stock.variantId, 'cache identity diverged for an unaffected image')
    assert.deepEqual(capped.data, stock.data, 'bytes diverged for an unaffected image')
    assert.equal(capped.width, 1446)
    assert.equal(capped.height, 837)
  })

  it('preserves aspect ratio within a pixel of the source', async () => {
    const { limitedRef } = await save(3000, 300)
    const version = await limited.readImageRequest(limitedRef, ROUTE_POLICY)
    const sourceRatio = 3000 / 300
    const resultRatio = version.width / version.height
    assert.ok(Math.abs(sourceRatio - resultRatio) / sourceRatio < 0.02, `ratio drifted: ${resultRatio}`)
  })

  it('returns a stable variant id and reuses the cache across calls', async () => {
    const { limitedRef } = await save(2048, 473)
    const first = await limited.readImageRequest(limitedRef, ROUTE_POLICY)
    const second = await limited.readImageRequest(limitedRef, ROUTE_POLICY)
    assert.equal(first.variantId, second.variantId)
    assert.deepEqual(first.data, second.data)
  })

  it('declares metadata the provider contract requires', async () => {
    const { limitedRef } = await save(3840, 2160)
    const version = await limited.readImageRequest(limitedRef, ROUTE_POLICY)
    assert.equal(version.depth, 'uchar')
    assert.equal(version.space, 'srgb')
    assert.equal(version.bytes, version.data.byteLength)
    assert.ok(['image/png', 'image/jpeg', 'image/webp'].includes(version.mediaType))
  })

  it('still honours a route budget stricter than the side cap', async () => {
    const { limitedRef } = await save(2048, 473)
    const strict: ImageRequestPolicy = { maxPixels: 160_000, maxBytes: 1024 * 1024 }
    const version = await limited.readImageRequest(limitedRef, strict)
    assert.ok(version.width * version.height <= strict.maxPixels)
    assert.ok(Math.max(version.width, version.height) <= MAX_SIDE)
  })

  it('rejects a non-positive side cap at construction', () => {
    assert.throws(
      () => new SideLimitedAttachmentStore(new Context(), { dshHome: join(home, 'bad'), maxRequestImageSide: 0 }),
      /maxRequestImageSide/,
    )
  })

  it('registers on the attachments slot', () => {
    const ctx = new Context()
    const store = new SideLimitedAttachmentStore(ctx, { dshHome: join(home, 'slot') })
    // Cordis hands out a context-tracking Proxy, so identity is checked
    // through observable state rather than reference equality.
    const provided = ctx.get('attachments')
    assert.ok(provided instanceof LocalAttachmentStore)
    assert.equal((provided as SideLimitedAttachmentStore).maxRequestImageSide, store.maxRequestImageSide)
    assert.equal(provided.root, store.root)
  })
})

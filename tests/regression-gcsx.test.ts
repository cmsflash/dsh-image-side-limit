/**
 * Regression against the exact image that bricked a real session.
 *
 * A 2048x473 banner pasted into a DSH thread sat under every pixel and byte
 * budget yet exceeded Anthropic's 2000px per-side limit, so once that session
 * carried more than twenty images every subsequent request failed with
 * `invalid_request_error` and no future turn could succeed.
 *
 * The fixture is reconstructed at those exact dimensions rather than read from
 * `~/.dsh`, so the test runs anywhere and depends on no private data.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { ImageRequestPolicy } from '@deepseek-ai/dsh-attachment'
import { SideLimitedAttachmentStore } from '../src/index.ts'

/** The banner's source dimensions before DSH normalized it to a 2048 long edge. */
const ORIGINAL = { width: 3248, height: 750 }
/** What normalization stored, and what every later request rebuilt. */
const STORED = { width: 2048, height: 473 }
/** Anthropic's per-side cap for requests carrying more than twenty images. */
const ANTHROPIC_MANY_IMAGE_MAX_SIDE = 2000

const ROUTE_POLICY: ImageRequestPolicy = { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 }

let home: string

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-gcsx-'))
})

after(async () => {
  await rm(home, { recursive: true, force: true })
})

/** An RGBA banner with alpha, matching the original's PNG encoding. */
async function banner(width: number, height: number): Promise<Uint8Array> {
  const channels = 4 as const
  const raw = Buffer.alloc(width * height * channels)
  for (let i = 0; i < raw.length; i += channels) {
    raw[i] = (i / 7) % 256
    raw[i + 1] = (i / 13) % 256
    raw[i + 2] = (i / 29) % 256
    raw[i + 3] = 255
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels } }).png().toBuffer())
}

describe('GCSX regression: 2048x473 banner', () => {
  it('reproduces the failure with the stock store', async () => {
    const store = new LocalAttachmentStore(new Context(), { dshHome: join(home, 'stock') })
    const ref = await store.saveImage({
      data: await banner(STORED.width, STORED.height),
      mediaType: 'image/png',
      name: 'image.png',
    })
    assert.equal(ref.width, STORED.width)

    const version = await store.readImageRequest(ref, ROUTE_POLICY)
    const decoded = await sharp(version.data).metadata()
    assert.ok(
      Math.max(decoded.width, decoded.height) > ANTHROPIC_MANY_IMAGE_MAX_SIDE,
      'expected the stock store to reproduce the oversized request version',
    )
  })

  it('admits the original 3248x750 paste and still serves a compliant request', async () => {
    // The whole failure began at admission: DSH accepts a large paste and
    // downscales it to a 2048 long edge, 48px above the provider limit.
    const store = new SideLimitedAttachmentStore(new Context(), { dshHome: join(home, 'fixed') })
    const ref = await store.saveImage({
      data: await banner(ORIGINAL.width, ORIGINAL.height),
      mediaType: 'image/png',
      name: 'image.png',
    })
    assert.equal(ref.width, STORED.width, 'normalization should still store a 2048 long edge')
    assert.equal(ref.height, STORED.height)

    const version = await store.readImageRequest(ref, ROUTE_POLICY)
    const decoded = await sharp(version.data).metadata()
    assert.ok(
      Math.max(decoded.width, decoded.height) <= ANTHROPIC_MANY_IMAGE_MAX_SIDE,
      `request version ${decoded.width}x${decoded.height} still exceeds the provider cap`,
    )
  })

  it('keeps the banner readable rather than shrinking it to fit', async () => {
    // A total-pixel budget low enough to fix this banner would also shrink
    // ordinary screenshots; the side cap must cost almost nothing here.
    const store = new SideLimitedAttachmentStore(new Context(), { dshHome: join(home, 'quality') })
    const ref = await store.saveImage({
      data: await banner(STORED.width, STORED.height),
      mediaType: 'image/png',
      name: 'image.png',
    })
    const version = await store.readImageRequest(ref, ROUTE_POLICY)
    assert.ok(version.width >= 1990, `expected a long edge just under the cap, got ${version.width}`)
    assert.ok(version.width <= ANTHROPIC_MANY_IMAGE_MAX_SIDE)
  })

  it('holds for a full twenty-one-image history', async () => {
    // The provider rule only engages past twenty images, which is exactly why
    // the session ran fine for six turns and then could never recover.
    const store = new SideLimitedAttachmentStore(new Context(), { dshHome: join(home, 'history') })
    const screenshots = await Promise.all(
      Array.from({ length: 20 }, () => banner(1446, 837).then(data => (
        store.saveImage({ data, mediaType: 'image/png', name: 'shot.png' })
      ))),
    )
    const oversized = await store.saveImage({
      data: await banner(STORED.width, STORED.height),
      mediaType: 'image/png',
      name: 'image.png',
    })

    const versions = await Promise.all(
      [...screenshots, oversized].map(ref => store.readImageRequest(ref, ROUTE_POLICY)),
    )
    assert.equal(versions.length, 21)
    for (const version of versions) {
      const decoded = await sharp(version.data).metadata()
      assert.ok(
        Math.max(decoded.width, decoded.height) <= ANTHROPIC_MANY_IMAGE_MAX_SIDE,
        `an image in a 21-image request is ${decoded.width}x${decoded.height}`,
      )
    }
  })
})

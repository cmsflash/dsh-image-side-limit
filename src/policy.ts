/**
 * Per-side clamping of one model-request image target.
 *
 * A route asks the attachment store for an `ImageRequestTarget`: target width
 * and height, already projected from the route's pixel budget, plus an
 * encoded-byte target. A pixel budget cannot express a per-side limit: at a
 * fixed pixel count the long edge grows without bound as the aspect ratio
 * widens, so a 3000x300 strip is only 900,000 pixels yet 3000px wide. Providers
 * that cap a single dimension — Anthropic rejects any side above 2000px once a
 * request carries more than twenty images — therefore refuse images that every
 * pixel budget admits.
 *
 * The target already names its dimensions, so the cap is a long-edge clamp.
 * The store resizes by the source's long edge and lets the encoder round the
 * short edge; `longEdgeDimensions` from `@deepseek-ai/dsh-attachment` predicts
 * exactly that rounding.
 *
 * @module
 */

import { longEdgeDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageRequestTarget } from '@deepseek-ai/dsh-attachment'

/** Intrinsic dimensions of one stored normalized attachment. */
export interface SourceDimensions {
  width: number
  height: number
}

/**
 * Narrow one route target so the derived request image also respects a per-side cap.
 *
 * Returns the original target object by identity when the route's own target
 * already fits, which keeps that image's request-version cache key unchanged:
 * the store derives its variant id from the target fields. `maxBytes` is never
 * relaxed, and a route target stricter than the cap is never enlarged.
 *
 * @param source - intrinsic dimensions of the stored normalized attachment.
 * @param target - the route-owned target to narrow.
 * @param maxSide - positive per-side pixel cap.
 * @returns the original target, or a copy whose dimensions also satisfy the cap.
 */
export function clampTargetToSide(
  source: SourceDimensions,
  target: ImageRequestTarget,
  maxSide: number,
): ImageRequestTarget {
  const routeLongEdge = source.width >= source.height ? target.width : target.height
  const produced = longEdgeDimensions(source.width, source.height, routeLongEdge)
  if (Math.max(produced.width, produced.height) <= maxSide) return target
  const capped = longEdgeDimensions(source.width, source.height, maxSide)
  return { ...target, width: capped.width, height: capped.height }
}

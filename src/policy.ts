/**
 * Per-side clamping expressed as a total-pixel budget.
 *
 * `ImageRequestPolicy` bounds a request version by total pixels
 * (`maxPixels`) and encoded bytes, and the backend projects dimensions with
 * `scale = sqrt(maxPixels / (width * height))`. A total-pixel budget cannot
 * express a per-side limit: at a fixed pixel count the long edge still grows
 * without bound as the aspect ratio widens, so a 3000x300 strip is only
 * 900,000 pixels yet 3000px wide. Providers that cap a single dimension —
 * Anthropic rejects any side above 2000px once a request carries more than
 * twenty images — therefore refuse images that every pixel budget admits.
 *
 * Narrowing `maxPixels` per image closes that gap without a new backend
 * method: for one exact source, the pixel count at which the projection
 * lands on the side cap is computable, so the clamped budget makes the
 * existing projection produce a compliant long edge.
 *
 * @module
 */

/** Total-pixel and encoded-byte budgets for one derived model-request image. */
export interface RequestPolicy {
  /** Maximum width multiplied by height after aspect-preserving projection. */
  maxPixels: number
  /** Encoded-byte cap before base64 expansion or Files API upload. */
  maxBytes: number
}

/** Intrinsic dimensions of one stored normalized attachment. */
export interface SourceDimensions {
  width: number
  height: number
}

/**
 * Project dimensions under a total-pixel budget.
 *
 * Mirrors the backend's own projection so a clamped budget can be chosen
 * against the dimensions the backend will actually produce. Rounding is
 * inward on the driving edge and nearest on the derived edge, then the
 * driving edge steps down until the product fits, which keeps the result
 * within the budget for aspect ratios where nearest-rounding would exceed it.
 *
 * @param width - positive source width.
 * @param height - positive source height.
 * @param maxPixels - positive width-times-height cap.
 * @returns projected dimensions; a source already within budget is returned unchanged.
 */
export function projectDimensions(width: number, height: number, maxPixels: number): SourceDimensions {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/**
 * The largest total-pixel budget whose projection keeps both sides within `maxSide`.
 *
 * The analytic candidate `floor(w*f) * floor(h*f)` for `f = maxSide/longest`
 * is the starting point, not the answer: the projection re-derives the short
 * edge by nearest-rounding, which can land one pixel above the cap. The
 * candidate is verified against {@link projectDimensions} and stepped down
 * until the projection itself complies, so the returned budget is correct by
 * construction rather than by derivation.
 *
 * @param width - positive source width.
 * @param height - positive source height.
 * @param maxSide - positive per-side pixel cap.
 * @returns a positive budget whose projection satisfies the cap.
 */
export function budgetForSideCap(width: number, height: number, maxSide: number): number {
  const longest = Math.max(width, height)
  if (longest <= maxSide) return width * height
  const factor = maxSide / longest
  let budget = Math.max(1, Math.floor(width * factor) * Math.floor(height * factor))
  for (;;) {
    const projected = projectDimensions(width, height, budget)
    if (Math.max(projected.width, projected.height) <= maxSide) return budget
    if (budget <= 1) return 1
    budget -= 1
  }
}

/**
 * Narrow one route policy so the derived request image also respects a per-side cap.
 *
 * Returns the original policy object by identity when the source already fits,
 * which keeps that image's request-version cache key unchanged: the backend
 * derives its variant id from `maxPixels` and `maxBytes`, so an unnecessary
 * new object would still hash equal, but preserving identity documents that
 * unaffected images are not reprocessed. `maxBytes` is never relaxed.
 *
 * @param source - intrinsic dimensions of the stored normalized attachment.
 * @param policy - the route-owned policy to narrow.
 * @param maxSide - positive per-side pixel cap.
 * @returns the original policy, or a copy whose `maxPixels` also enforces the cap.
 */
export function clampPolicyToSide(
  source: SourceDimensions,
  policy: RequestPolicy,
  maxSide: number,
): RequestPolicy {
  const projected = projectDimensions(source.width, source.height, policy.maxPixels)
  if (Math.max(projected.width, projected.height) <= maxSide) return policy
  const budget = budgetForSideCap(source.width, source.height, maxSide)
  return { ...policy, maxPixels: Math.min(policy.maxPixels, budget) }
}

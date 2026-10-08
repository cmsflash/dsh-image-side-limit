import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageRequestTarget } from '@deepseek-ai/dsh-attachment'

/** pi-ai's default per-route request-image pixel budget. */
export const ROUTE_BUDGET = 2048 * 2048
/** Encoded-byte target used by every test route. */
export const MAX_BYTES = 1024 * 1024

/**
 * The target a pi-ai route requests for one stored image: its pixel budget
 * projected onto the image, plus the byte target.
 * @param width - stored attachment width.
 * @param height - stored attachment height.
 * @param maxPixels - route pixel budget.
 * @returns the route's request target for that image.
 */
export function routeTarget(width: number, height: number, maxPixels = ROUTE_BUDGET): ImageRequestTarget {
  return { ...requestImageDimensions(width, height, maxPixels), maxBytes: MAX_BYTES }
}

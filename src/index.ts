/**
 * Per-side dimension cap for model-request images (`ctx.attachments`).
 *
 * Mounts in place of `@deepseek-ai/dsh-attachment-local`, not beside it:
 * `ctx.attachments` is a single service slot and `reflect.provide` throws when
 * a second fiber claims a registered name, so a decorator cannot layer over
 * the local store. Subclassing keeps every storage behavior — admission,
 * content addressing, digest verification, the request-version cache — and
 * overrides only the derivation of request bytes.
 *
 * The override rewrites the *target*, never the image: it narrows the target
 * dimensions for the one image that needs it and delegates. Request bytes stay
 * a pure function of the stored attachment and the target, so the backend's
 * variant id (a digest over `attachmentId`, the target width, height, and
 * `maxBytes`, and fixed encoder parameters) still identifies the result exactly
 * and the on-disk cache stays correct. Images already within the cap are
 * delegated with the identical target and keep their existing cache entries.
 *
 * @module
 */

import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { clampTargetToSide } from './policy.ts'

export { clampTargetToSide } from './policy.ts'
export type { SourceDimensions } from './policy.ts'

/**
 * Anthropic's per-side limit for requests carrying more than twenty images.
 * Used as the default because it is the only such cap this plugin exists to
 * satisfy; a deployment behind a different provider states its own.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_SIDE = 2000

/** Configuration accepted in addition to every `attachment-local` field. */
export interface Config {
  /**
   * Per-side pixel cap applied to derived model-request images. Storage is
   * unaffected: normalization still writes whatever
   * `normalizedImageMaxDimension` admits, and only the version sent to a
   * provider is clamped.
   */
  maxRequestImageSide?: number
}

/**
 * Local attachment storage whose model-request versions also respect a per-side cap.
 *
 * Reuses `LocalAttachmentStore.Config` so every storage option keeps working
 * when this plugin is mounted in the local store's place, and adds one field.
 */
export class SideLimitedAttachmentStore extends LocalAttachmentStore {
  static override Config = z.intersect([
    LocalAttachmentStore.Config,
    z.object({
      maxRequestImageSide: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_SIDE),
    }),
  ]) as unknown as typeof LocalAttachmentStore.Config

  /** Resolved per-side pixel cap for derived request versions. */
  readonly maxRequestImageSide: number

  constructor(ctx: Context, config: Config & ConstructorParameters<typeof LocalAttachmentStore>[1]) {
    super(ctx, config)
    const side = config.maxRequestImageSide ?? DEFAULT_MAX_REQUEST_IMAGE_SIDE
    if (!Number.isSafeInteger(side) || side < 1) {
      throw new Error('dsh-image-side-limit: maxRequestImageSide must be a positive safe integer')
    }
    this.maxRequestImageSide = side
  }

  /**
   * Derive one request version whose long edge is within the configured cap.
   * @param ref - durable normalized attachment reference.
   * @param target - route-owned target dimensions and encoded-byte target.
   * @param signal - optional cancellation forwarded to the delegate.
   * @returns the delegate's request version, derived under a target that also satisfies the side cap.
   */
  override readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return super.readImageRequest(ref, clampTargetToSide(ref, target, this.maxRequestImageSide), signal)
  }
}

export default SideLimitedAttachmentStore

# dsh-image-side-limit

A per-side dimension cap for DeepSeek Harness model-request images.

Providers cap a single dimension; DSH bounds an image by *total pixels*. Those
two limits are not interchangeable, and the gap between them can permanently
break a session.

## The problem

Anthropic rejects any image whose width or height exceeds **2000px** once a
request carries more than twenty images:

```
messages.34.content.1.image.source.base64.data: At least one of the image
dimensions exceed max allowed size for many-image requests: 2000 pixels
```

A request version is derived from an `ImageRequestTarget` that each route
projects from its total-pixel budget (`requestImagePixelBudget`), and a pixel
budget cannot express "no side above N".

Normalization does not save you, and on current `master` it is the more
exposed of the two arrangements. A release that caps the stored long edge at
2048px still sits 48px above the provider limit; `master` bounds storage by
total pixels (`normalizedImageMaxPixels`, 2048²), so a 3248x750 paste is only
2.4M pixels and is stored — and sent — at its full 3248px width.

The failure is permanent rather than transient. A session log stores an
attachment *reference*, and request bytes are re-derived from it on every turn,
so once an oversized image is in history each later request rebuilds the same
illegal image. Past twenty images, every turn fails and the session cannot
recover.

A wide image slips through even a generous pixel budget: a 2048x473 banner is
968,704 pixels, well under a 2048² budget, so nothing ever shrinks it.

## Why a pixel budget cannot substitute

Lowering `requestImagePixelBudget` is the closest built-in lever, and it is not
enough. The long edge falls out of `sqrt(budget / (w × h))`, so the result
depends on aspect ratio:

| Source | Route default | Budget 923,828 | Side cap 2000 |
|---|---|---|---|
| 2048x473 banner | 2048x473 ✗ | 1999x462 ✓ | 2000x462 ✓ |
| 1446x837 screenshot | 1446x837 ✓ | 1263x731 (degraded) | 1446x837 ✓ |
| 3000x300 strip | 3000x300 ✗ | 3000x300 ✗ | 2000x200 ✓ |
| 400x3000 portrait | 400x3000 ✗ | 400x3000 ✗ | 267x2000 ✓ |

Any budget low enough to fix the banner also degrades every ordinary
screenshot, and no usable budget fixes the strip or the portrait at all.

## What this plugin does

It rewrites the **target**, never the image. When the route's target would
produce a long edge above the cap, it replaces the target dimensions with the
source projected to exactly the cap, then delegates to the stock backend. A
route target already stricter than the cap is never enlarged, and `maxBytes` is
never relaxed.

Request bytes therefore remain a pure function of the stored attachment and the
target. The backend's variant id is a digest over `attachmentId`, the target
width, height, and `maxBytes`, and fixed encoder parameters, so the on-disk
cache stays correct: a narrowed target yields a new entry, and an unaffected
image is delegated with the identical target and keeps its existing one.

Storage is untouched. Only what goes on the wire is clamped, which is where the
rejection happens — so mounting this fixes sessions whose oversized images are
already in history.

## Install

```sh
pnpm add @dsh-external/dsh-image-side-limit
dsh --profile web --patch node_modules/@dsh-external/dsh-image-side-limit/cordis.patch.yml
```

Requires a DSH whose attachment API takes an `ImageRequestTarget` (upstream
since Sep 10, 2026; `0.1.6-alpha.2` and later). Earlier DSH releases passed an
`ImageRequestPolicy` instead; this plugin no longer supports them.

> **Build from a DSH checkout, not npm.** The dev dependencies link
> `../../deepseek-harness`, so clone this repository beside your DSH checkout,
> then `pnpm install && pnpm run build`. `lib/` is not committed.

`ctx.attachments` is a single service slot and Cordis throws when a second
fiber claims a registered name, so this cannot layer over the local store. It
ships as a subclass of `LocalAttachmentStore` mounted in its place; the bundled
patch disables `attachment-local` and inserts this row. Every `attachment-local`
config field still applies, so a deployment that customized the local store
moves those values onto this row.

```yaml
- id: attachment-local
  disabled: true

- insert:
    - id: attachment-side-limited
      name: '@dsh-external/dsh-image-side-limit'
      config:
        maxRequestImageSide: 2000
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxRequestImageSide` | `2000` | Per-side pixel cap for derived request images. |

Plus every field of `@deepseek-ai/dsh-attachment-local`.

## Tests

```sh
pnpm test
```

21 tests. The unit tests cover the target clamp, including a swept range of
aspect ratios in both orientations and degenerate one-pixel strips. The integration and
regression suites run against the real `LocalAttachmentStore`, real `sharp`
encoding, and a temporary `DSH_HOME`; they decode the produced bytes rather
than trusting reported metadata, assert that the stock store still reproduces
the oversized version (so a passing run cannot be vacuous), and replay a full
twenty-one-image history.

Verified against the actual bytes that broke a real session:

```
stock attachment-local   stored 2048x473 -> request 2048x473  REJECTED by Anthropic
with side-limit plugin   stored 2048x473 -> request 2000x462  ACCEPTED
```

Re-pasting that banner at its original size:

```
stock attachment-local   stored 3248x750 -> request 3248x750  REJECTED by Anthropic
with side-limit plugin   stored 3248x750 -> request 2000x462  ACCEPTED
```

## Scope

This clamps request versions. It does not alter stored bytes, so it does not
rewrite an existing session log — it makes those logs serviceable again. The
underlying gap is that a route's image budget has no per-side field; adding one
upstream would make this plugin unnecessary.

## License

MIT

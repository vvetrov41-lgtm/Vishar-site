# Large Scale gallery uploads

Upload finished large-scale realism work here using zero-padded JPG names:

- `01.jpg`
- `02.jpg`
- `03.jpg`
- ...

The gallery is manifest-driven. Every image that should appear on the page must have a matching two-digit key in `metadata.json`. Files without a metadata key are not rendered, which prevents hosting fallbacks from creating phantom gallery cards.

## Source requirements

- JPG/JPEG source, sRGB preferred
- no watermarks or screenshots
- use the strongest full-body-area / sleeve view as the primary image
- minimum useful long edge: about 1600 px
- portrait-oriented images work best in the current gallery cards
- do not place unrelated small tattoos here just to fill the gallery

## Metadata manifest

`metadata.json` is required for published images. Keys use the two-digit image number:

```json
{
  "_gallery": {
    "thumbnailWidths": [320, 480, 720, 960]
  },
  "01": {
    "alt": "Full colour realism sleeve by Vladimir Vishar",
    "caption": "Full sleeve, colour realism"
  }
}
```

`_gallery.thumbnailWidths` declares which responsive WebP thumbnail sizes exist for every published image. If it is omitted, the page safely falls back to the JPG source.

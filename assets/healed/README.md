# Healed gallery uploads

Only upload photographs that are explicitly confirmed as healed. Do not place same-day or fresh-session images in this folder.

Use zero-padded JPG names:

- `01.jpg`
- `02.jpg`
- `03.jpg`
- ...

The gallery is manifest-driven. Every image that should appear on the page must have a matching two-digit key in `metadata.json`. Files without a metadata key are not rendered.

## Source requirements

- confirmed healed tattoo only
- JPG/JPEG source, sRGB preferred
- no watermarks or screenshots
- minimum useful long edge: about 1600 px
- avoid aggressive editing that materially changes contrast or colour
- where known, record how long the tattoo had been healed in `metadata.json`

## Metadata manifest

Example:

```json
{
  "_gallery": {
    "thumbnailWidths": [320, 480, 720, 960]
  },
  "01": {
    "alt": "Healed colour realism tattoo by Vladimir Vishar",
    "caption": "Healed 8 months",
    "healed_for": "8 months"
  }
}
```

`_gallery.thumbnailWidths` declares which responsive WebP thumbnail sizes exist for every published image. If it is omitted, the page safely falls back to the JPG source. If a healing interval is unknown, leave it out rather than guessing.

# Large Scale gallery uploads

Upload finished large-scale realism work here using consecutive zero-padded JPG names:

- `01.jpg`
- `02.jpg`
- `03.jpg`
- ...

Keep numbering consecutive with no gaps. The page gallery discovers files in order and stops at the first missing number.

## Source requirements

- JPG/JPEG source, sRGB preferred
- no watermarks or screenshots
- use the strongest full-body-area / sleeve view as the primary image
- minimum useful long edge: about 1600 px
- portrait-oriented images work best in the current gallery cards
- do not place unrelated small tattoos here just to fill the gallery

## Metadata

Optional per-image text lives in `metadata.json`. Keys use the two-digit image number. Example:

```json
{
  "01": {
    "alt": "Full colour realism sleeve by Vladimir Vishar",
    "caption": "Full sleeve, colour realism"
  }
}
```

If metadata is omitted, the site uses a safe generic alt label.

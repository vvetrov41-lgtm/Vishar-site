# Healed gallery uploads

Only upload photographs that are explicitly confirmed as healed. Do not place same-day or fresh-session images in this folder.

Use consecutive zero-padded JPG names:

- `01.jpg`
- `02.jpg`
- `03.jpg`
- ...

Keep numbering consecutive with no gaps. The page gallery discovers files in order and stops at the first missing number.

## Source requirements

- confirmed healed tattoo only
- JPG/JPEG source, sRGB preferred
- no watermarks or screenshots
- minimum useful long edge: about 1600 px
- avoid aggressive editing that materially changes contrast or colour
- where known, record how long the tattoo had been healed in `metadata.json`

## Metadata

Example:

```json
{
  "01": {
    "alt": "Healed colour realism tattoo by Vladimir Vishar",
    "caption": "Healed 8 months",
    "healed_for": "8 months"
  }
}
```

If a healing interval is unknown, leave it out rather than guessing.

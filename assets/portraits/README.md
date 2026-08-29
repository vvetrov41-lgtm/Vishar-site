# Portrait gallery uploads

Upload finished portrait realism work here using consecutive zero-padded JPG names:

- `01.jpg`
- `02.jpg`
- `03.jpg`
- ...

Keep numbering consecutive with no gaps. The page gallery discovers files in order and stops at the first missing number.

## Source requirements

- JPG/JPEG source, sRGB preferred
- no watermarks, screenshots or heavily compressed social-media exports when the original exists
- the face should be large enough to judge likeness, light and skin transitions
- minimum useful long edge: about 1600 px
- both colour and black-and-grey portraits are suitable

## Metadata

Optional per-image text lives in `metadata.json`. Keys use the two-digit image number. Example:

```json
{
  "01": {
    "alt": "Black and grey portrait tattoo by Vladimir Vishar",
    "caption": "Black and grey portrait, upper arm"
  }
}
```

If metadata is omitted, the site uses a safe generic alt label.

# Portrait gallery uploads

Upload finished portrait realism work here using zero-padded JPG names:

- `01.jpg`
- `02.jpg`
- `03.jpg`
- ...

The gallery is manifest-driven. Every image that should appear on the page must have a matching two-digit key in `metadata.json`. Files without a metadata key are not rendered.

## Source requirements

- JPG/JPEG source, sRGB preferred
- no watermarks, screenshots or heavily compressed social-media exports when the original exists
- the face should be large enough to judge likeness, light and skin transitions
- minimum useful long edge: about 1600 px
- both colour and black-and-grey portraits are suitable

## Metadata manifest

`metadata.json` is required for published images. Keys use the two-digit image number:

```json
{
  "_gallery": {
    "thumbnailWidths": [320, 480, 720, 960]
  },
  "01": {
    "alt": "Black and grey portrait tattoo by Vladimir Vishar",
    "caption": "Black and grey portrait, upper arm"
  }
}
```

`_gallery.thumbnailWidths` declares which responsive WebP thumbnail sizes exist for every published image. If it is omitted, the page safely falls back to the JPG source.

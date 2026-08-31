# Research

Google Calendar's 2026 event-label API supersedes legacy `colorId` for custom event colors.

- `Events.eventLabelId` is writable and requires `eventLabelVersion=1` on insert/update/patch.
- The label ID must refer to `Calendars.labelProperties.eventLabels` for the calendar.
- Reading calendar metadata requires a calendar metadata/read scope; `calendar.events` alone is insufficient.
- Assigning a label requires writer-level calendar access, but this workstream only reads the existing label catalogue and assigns an existing label to the artist's own event.
- Legacy event color ID `9` is Blueberry.
- Wisteria is not in the legacy 1-11 event color set. The modern Wisteria color is `#b39ddb`, so substituting legacy Grape would be incorrect.

Implementation consequence: Vladimir can keep backward-compatible Blueberry with `colorId=9`. Kristina needs one OAuth reconnect after rollout so the connector can obtain read-only calendar metadata permission, resolve her existing Wisteria label UUID, and keep that UUID inside the encrypted artist token envelope.

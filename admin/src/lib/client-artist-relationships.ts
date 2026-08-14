import type { Artist } from './types';

export interface ClientArtistRecord {
  client_id: string;
  artist_id: string;
}

export function collectClientArtistIds(
  ...recordGroups: ClientArtistRecord[][]
): Map<string, string[]> {
  const grouped = new Map<string, Set<string>>();

  for (const records of recordGroups) {
    for (const record of records) {
      const artistIds = grouped.get(record.client_id) ?? new Set<string>();
      artistIds.add(record.artist_id);
      grouped.set(record.client_id, artistIds);
    }
  }

  return new Map(
    Array.from(grouped, ([clientId, artistIds]) => [clientId, Array.from(artistIds)])
  );
}

export function resolveArtistNames(artistIds: string[], artists: Artist[]): string[] {
  const requested = new Set(artistIds);
  return artists
    .filter((artist) => requested.has(artist.id))
    .map((artist) => artist.display_name);
}

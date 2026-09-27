import { useRef } from 'react';

/**
 * A detail page shows its full-page loader only for the first load of a
 * record. A reload of the record already on screen (after an action) keeps
 * the page mounted, so panel state such as a just-created deposit link,
 * a success notice or open sections survives the refresh.
 */
export function isBlockingDetailLoad(
  loading: boolean,
  loadedRecordId: string | null | undefined,
  routeRecordId: string
): boolean {
  return loading && loadedRecordId !== routeRecordId;
}

/**
 * For pages whose loaded data does not carry its own id: remembers which
 * record key was last loaded, so a reload of the same record keeps the page
 * mounted while a switch to another record still shows the loader.
 */
export function useBlockingLoad(loading: boolean, hasData: boolean, recordKey: string): boolean {
  const loadedKey = useRef<string | null>(null);
  if (!loading && hasData) loadedKey.current = recordKey;
  return loading && loadedKey.current !== recordKey;
}

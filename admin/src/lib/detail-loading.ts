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

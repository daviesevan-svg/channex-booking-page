/** Whether an in-app navigation away from the inventory grid should be blocked.
 *  A save is a POST to the same URL, so it must not count: that submission is
 *  what clears the edits. */
export function inventoryLeaveBlocked(
  dirty: number,
  current: { pathname: string; search: string },
  next: { pathname: string; search: string },
): boolean {
  return dirty > 0 && (next.pathname !== current.pathname || next.search !== current.search);
}

/** A successful save revalidates this same URL, so the grid's date keys do not
 *  change and React keeps the uncontrolled inputs mounted. `defaultValue` is
 *  only applied on mount, so the dirty count stays above zero and the leave
 *  guard blocks every later navigation. Bump the form epoch once per successful
 *  action so the inputs remount against the values just stored. */
export function nextInventoryFormEpoch(
  epoch: number,
  seen: unknown,
  action: { ok?: boolean } | null | undefined,
): { epoch: number; seen: unknown } {
  if (action?.ok && action !== seen) return { epoch: epoch + 1, seen: action };
  return { epoch, seen };
}

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

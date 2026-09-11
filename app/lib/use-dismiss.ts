import { useEffect, type RefObject } from "react";

/**
 * Close a popover on a pointer-down outside `ref`, or on Escape.
 *
 * The popovers used to do this with an invisible full-screen backdrop that
 * closed them on click. That backdrop also SWALLOWED the click: with the
 * calendar still open after picking check-out, a guest's next click on
 * "Search rooms" hit the backdrop, closed the calendar, and never reached the
 * button — the click landed, nothing happened (customer report, 2026-09-11).
 * A document listener closes the popover without taking the click away from
 * whatever is underneath, so the same click both dismisses and acts.
 *
 * `pointerdown` rather than `click`: the opening click has finished
 * dispatching before this listener is added, so it can never close what it
 * just opened, and pressing outside dismisses before the release.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void) {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, onDismiss]);
}

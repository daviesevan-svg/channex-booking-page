import { useLayoutEffect, type RefObject } from "react";

/**
 * Keep a trigger-anchored popover inside the viewport. The date and guest
 * popovers hang off their trigger's LEFT edge at a vw-based width, so on a phone,
 * where the trigger sits inside the page gutter, they ran past the right edge and
 * the page scrolled sideways. Caps max-width to leave a page-gutter margin on the
 * right: the trigger's own left offset, but never more than the 28px gutter (so a
 * trigger far to the right on a wide screen isn't squeezed) nor less than 12px.
 * On a phone that mirrors the gutter; on a wide screen the cap never bites.
 *
 * Layout offsets, not getBoundingClientRect: a template's entrance animation can
 * still be sliding the trigger in when this first runs. The root's clientWidth,
 * not innerWidth: the unclamped popover has already widened a phone's layout
 * viewport by the time this runs (375 → 388), and innerWidth reports the widened
 * one. Measured in a layout effect, not a rAF — rAF never fires in a hidden tab.
 */
export function useViewportClamp(ref: RefObject<HTMLElement | null>, active = true) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const apply = () => {
      let left = 0;
      for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) left += n.offsetLeft;
      const vw = document.documentElement.clientWidth;
      const right = Math.max(12, Math.min(left, 28));
      el.style.maxWidth = `${Math.max(240, Math.round(vw - left - right))}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [ref, active]);
}

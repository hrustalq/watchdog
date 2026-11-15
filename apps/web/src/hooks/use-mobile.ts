import { useMediaQuery } from "usehooks-ts";

const MOBILE_QUERY = "(max-width: 767px)";

/**
 * True below the `md` breakpoint, as DESIGN.md's responsive layout expects. It starts false, as the
 * server rendered it, and the first layout effect swaps in the window's answer before the paint.
 */
export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY, { initializeWithValue: false });
}

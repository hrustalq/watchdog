import type { CSSProperties } from "react"

/**
 * React's CSSProperties omits custom properties, which the design tokens use.
 * A style object typed with this carries them without a type assertion.
 */
export type StyleWithVariables = CSSProperties &
  Record<`--${string}`, string | number>

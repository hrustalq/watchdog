/**
 * A cost as an exact decimal string, in whatever scale the arithmetic produced: "0.0000125", "7.5".
 * Money never goes through a float on its way here, and `null` means no priced call to estimate from.
 */
export type Cost = string;

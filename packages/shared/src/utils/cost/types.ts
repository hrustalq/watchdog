// A cost as an exact decimal string, in whatever scale the arithmetic produced: "0.0000125",
// "7.5". Money never goes through a float on its way here.
export type Cost = string;

// Only catches a hang: a loaded CI runner can take several times as long as a quiet one.
export default { test: { testTimeout: 60_000 } };

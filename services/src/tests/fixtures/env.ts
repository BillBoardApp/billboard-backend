export type EnvOverrides = Record<string, string | undefined>;

export const snapshotEnv = (): NodeJS.ProcessEnv => ({ ...process.env });

/**
 * Applies environment overrides for a test and returns a restore function.
 *
 * - Default mode (`replace: false`) mutates only the provided keys.
 * - `replace: true` replaces `process.env` with `{...base, ...overrides}`.
 */
export const applyTestEnv = (
  overrides: EnvOverrides,
  options?: { replace?: boolean; base?: NodeJS.ProcessEnv },
): (() => void) => {
  const previousEnv = process.env;

  if (options?.replace) {
    process.env = { ...(options.base ?? previousEnv), ...overrides } as NodeJS.ProcessEnv;
    return () => {
      process.env = previousEnv;
    };
  }

  const previousValues: EnvOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    previousValues[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
};

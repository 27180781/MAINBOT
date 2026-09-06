/**
 * Imported first by every CLI entry point (ESM evaluates imports in order) so that the
 * dotenv banner ("injected env ... tip: ...") that src/config.ts triggers on stdout does
 * not corrupt machine-readable output such as `mcp:tools --json`. An explicit
 * DOTENV_CONFIG_QUIET set by the user wins.
 */
process.env.DOTENV_CONFIG_QUIET ??= "true";

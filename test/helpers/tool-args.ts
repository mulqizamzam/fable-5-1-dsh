/**
 * Arguments for a tool, derived from the tool's own declared schema.
 *
 * The generator itself lives in `src/tools/args.ts` now, because the two
 * tenant sweep is a shipped command that needs the same arguments. This file
 * re-exports it so the tests keep their short import path.
 */
export { valueFor, minimalArgs, OVERRIDES, argsFor } from '../../src/tools/args.ts'

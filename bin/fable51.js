#!/usr/bin/env node
/**
 * fable51 CLI shim.
 *
 * The implementation lives in src/cli.ts and ships compiled as lib/cli.js, so
 * the published package always has a binary that matches the bundle it ships.
 * This file is the only hand-written JS in the package.
 */
import { main } from '../lib/cli.js'

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error('Fatal error:', error)
    process.exitCode = 1
  })

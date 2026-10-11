/** Artifact and checksum contracts (specs 9, 16, 20, 70). */

/** A stage output contract: every stage emits one before its result is trusted. */
export interface ArtifactContract {
  readonly path: string
  readonly shape: string
  readonly schema: string
  readonly checksum: Checksum
}

/** `sha256:<hex>` content address. */
export type Checksum = string

/** A gate the bundle can actually execute: check + command + expected outcome (spec 5). */
export interface Gate {
  readonly id: string
  readonly check: string
  readonly cmd: string
  readonly expected: string
}

/** The observed outcome of running a Gate (specs 5, 12). */
export interface GateResult {
  readonly gate: string
  readonly cmd: string
  readonly expected: string
  readonly actual: string
  readonly pass: boolean
  readonly at: number
}

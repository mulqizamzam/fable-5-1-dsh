/** Bundle entry: the policy service IS the plugin (dsh-tools pattern). */
export { default } from './policy-service.ts'
export { Fable51Policy } from './policy-service.ts'
export type { Fable51Config } from './config/schema.ts'
export { validateConfig, ConfigError } from './config/schema.ts'

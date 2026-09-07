/**
 * Package-owned invariant companion for `dsh-terminal`.
 * @module dsh-terminal/invariant
 */

import type { Context } from './dsh-adapter/types.ts'
import type { InvariantInstaller } from './dsh-adapter/types.ts'

const PACKAGE_NAME = 'dsh-terminal'

/** Cordis companion plugin name. */
export const name = 'tui-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the driver is a direct Agent driver whose observable
 * contract (REPL lines to committed assistant output on stdout, flush before
 * exit) is process-level and owned by the composition and driver suites; it
 * registers no service and holds no mutable relation to audit inside the tree.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

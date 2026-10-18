import { receipt } from "./receipt.ts"
import type { LibraryTemplate } from "./types.ts"
import { welcome } from "./welcome.ts"

/**
 * The templates that ship with the repo. To add one: a file here exporting a LibraryTemplate (copy
 * welcome.ts), and an entry below. test/templates/library.test.ts renders every entry with its sample;
 * `bun run templates:install` installs them (skills/add-template/SKILL.md).
 */
export const LIBRARY: ReadonlyArray<LibraryTemplate> = [welcome, receipt]

export { type LibraryTemplate, toSource } from "./types.ts"

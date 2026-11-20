// The package version, for the CLIs' `--version`. Read from package.json at build time, so a
// release that bumps one cannot leave the other behind; the bundler keeps only this field.
import { version } from "../package.json"

export const VERSION: string = version

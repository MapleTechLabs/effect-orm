// Regression files through `node:fs`, apart from `node.ts` so that loading it
// does not load the inspector.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import * as Regressions from "./Regressions"

/** Regression files under `directory`. */
export const layer = (directory: string): Layer.Layer<never> =>
	Layer.succeed(
		Regressions.Regressions,
		Regressions.make({
			read: (file) =>
				Effect.promise(() =>
					readFile(join(directory, file), "utf8").catch((error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return undefined
						throw error
					}),
				),
			write: (file, text) =>
				Effect.promise(async () => {
					await mkdir(directory, { recursive: true })
					await writeFile(join(directory, file), text)
				}),
		}),
	)

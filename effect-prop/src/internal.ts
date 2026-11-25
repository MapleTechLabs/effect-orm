// Shared by the modules that print where something is.

/** With `/` between its parts on every platform, so a name built from a path is the same on each. */
const portable = (path: string): string => path.replace(/\\/g, "/")

const cwd = typeof process === "object" && typeof process.cwd === "function" ? portable(process.cwd()) : ""

/** A file path or `file://` URL, relative to the working directory when it is inside it. */
export const relativePath = (file: string): string => {
	const path = portable(file.replace(/^file:\/\//, ""))
	return cwd !== "" && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

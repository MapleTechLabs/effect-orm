// Shared by the modules that print where something is.

const cwd = typeof process === "object" && typeof process.cwd === "function" ? process.cwd() : ""

/** A file path or `file://` URL, relative to the working directory when it is inside it. */
export const relativePath = (file: string): string => {
	const path = file.replace(/^file:\/\//, "")
	return cwd !== "" && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

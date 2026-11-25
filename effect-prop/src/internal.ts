// Shared by the modules that print where something is.

/** With `/` between its parts on every platform, so a name built from a path is the same on each. */
const portable = (path: string): string => path.replace(/\\/g, "/")

const cwd = typeof process === "object" && typeof process.cwd === "function" ? portable(process.cwd()) : ""

/** The path a `file://` URL names: decoded, and with no slash before a Windows drive letter. */
const fromFileUrl = (url: string): string => {
	let path = url.slice("file://".length)
	try {
		path = decodeURIComponent(path)
	} catch {
		// Not percent-encoding after all: the text as it is.
	}
	return path.replace(/^\/(?=[A-Za-z]:\/)/, "")
}

/** A file path or `file://` URL, relative to `base` (the working directory) when it is inside it. */
export const relativePath = (file: string, base: string = cwd): string => {
	const path = file.startsWith("file://") ? fromFileUrl(file) : portable(file)
	const root = portable(base)
	return root !== "" && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

// A bug behind six nested comparisons: each matching character is a new branch.
export const parse = (input: string): number => {
	if (input[0] === "e") {
		if (input[1] === "f") {
			if (input[2] === "f") {
				if (input[3] === "e") {
					if (input[4] === "c") {
						if (input[5] === "t") {
							throw new Error("reached the needle")
						}
						return 5
					}
					return 4
				}
				return 3
			}
			return 2
		}
		return 1
	}
	return 0
}

export const neverCalled = (x: number): number => x + 1

/**
 * The site's logo, drawn once for every place it appears: the header and the
 * docs layout (Logo.astro) and the social cards (src/pages/og/_card.ts).
 * An inner join: two rings, their overlap filled. Each ring is an outer circle
 * drawn clockwise and an inner one counter-clockwise, so the hole survives the
 * default nonzero fill rule. Keep it a single-colour mark; each place fills it
 * with its own text colour. public/favicon.svg carries a copy of the paths.
 */
export const logo = {
  /** The drawing's box; callers size it by height and keep the ratio. */
  width: 24,
  height: 16,
  paths: [
    "M0.9 8A7.8 7.8 0 1 1 16.5 8A7.8 7.8 0 1 1 0.9 8ZM3.3 8A5.4 5.4 0 1 0 14.1 8A5.4 5.4 0 1 0 3.3 8Z",
    "M7.5 8A7.8 7.8 0 1 1 23.1 8A7.8 7.8 0 1 1 7.5 8ZM9.9 8A5.4 5.4 0 1 0 20.7 8A5.4 5.4 0 1 0 9.9 8Z",
    "M12 2.284A6.6 6.6 0 0 1 12 13.716A6.6 6.6 0 0 1 12 2.284Z",
  ],
};

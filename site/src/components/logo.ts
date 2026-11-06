/**
 * The site's logo, drawn once for every place it appears: the header and the
 * docs layout (Logo.astro) and the social cards (src/pages/og/_card.ts).
 * Three rows of falling length: a result set. Keep it a single-colour mark;
 * each place fills it with its own text colour.
 */
export const logo = {
  /** The drawing's box; callers size it by height and keep the ratio. */
  width: 32,
  height: 20,
  paths: [
    "M2.5 0H29.5A2.5 2.5 0 0 1 29.5 5H2.5A2.5 2.5 0 0 1 2.5 0Z",
    "M2.5 7.5H21.5A2.5 2.5 0 0 1 21.5 12.5H2.5A2.5 2.5 0 0 1 2.5 7.5Z",
    "M2.5 15H12.5A2.5 2.5 0 0 1 12.5 20H2.5A2.5 2.5 0 0 1 2.5 15Z",
  ],
};

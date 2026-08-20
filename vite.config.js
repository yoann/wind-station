// The site is served from a custom domain at the root, so no sub-path base.
// Only what lands in dist/ is deployed; the repo root is never exposed.
export default {
  base: '/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    // The source already uses 60_000, ??= and .at(-1); anything that runs ES
    // modules handles es2022, so keep the output close to what is written.
    target: 'es2022',
    emptyOutDir: true,
  },
};

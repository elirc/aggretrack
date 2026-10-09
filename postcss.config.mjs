// Used by the webpack production build (`next build --webpack`); dev uses
// Turbopack with the @tailwindcss/turbopack loader from next.config.ts.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;

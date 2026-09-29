/**
 * Frontend suite — jsdom + Testing Library, run through the repo's existing Jest
 * (same toolchain as the backend, two extra dev dependencies).
 *
 * Why a separate config rather than a Jest "project": the backend suite is
 * pinned to the node environment and its own tsconfig, and converting the root
 * config to projects would change how the existing 26 suites run. `npm test`
 * stays backend-only; `npm run test:ui` runs this, and `npm run test:all` runs
 * both.
 *
 * Constraint worth knowing before adding a page test: pages built by Vite may
 * use `import.meta.env` (LoginPage does), which TypeScript refuses under
 * CommonJS. Components and libs are fine; a page test needs a Vite-style ESM
 * transform (or the page's env access moved behind a helper).
 *
 * @type {import('jest').Config}
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  // The app's React lives in frontend/node_modules while @testing-library/react
  // is installed at the repo root. Without pinning every import to the app's
  // copies, a component renders with one React and the renderer with another and
  // every render fails with "Invalid hook call".
  moduleNameMapper: {
    '^react$': '<rootDir>/node_modules/react',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react-dom/client$': '<rootDir>/node_modules/react-dom/client',
    '^react/jsx-runtime$': '<rootDir>/node_modules/react/jsx-runtime',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'CommonJS',
          moduleResolution: 'node',
          jsx: 'react-jsx',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
  testTimeout: 15000,
};

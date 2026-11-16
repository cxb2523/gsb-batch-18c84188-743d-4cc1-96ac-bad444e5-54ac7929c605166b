import { playwrightLauncher } from '@web/test-runner-playwright'

// Redirect CJS packages to pre-bundled ESM versions (produced by scripts/bundle-test-vendors.mjs).
const vendorAlias = {
  name: 'vendor-alias',
  resolveImport({ source }) {
    if (source === 'regl')  return '/test/vendor/regl.esm.js'
    if (source === 'proj4') return '/test/vendor/proj4.esm.js'
  },
}

// PLAYWRIGHT_EXECUTABLE_PATH allows pointing the launcher at a system-installed
// Chromium/Chrome when the Playwright browser download is unavailable.
const launchOptions = {
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
}
if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
}

export default {
  files: 'test/**/*.test.js',
  nodeResolve: true,
  browsers: [
    playwrightLauncher({
      product: 'chromium',
      launchOptions,
    }),
  ],
  plugins: [vendorAlias],
}

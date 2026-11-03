// Production-build smoke config (see prod-build.spec.js): the app's real vite.config.js (so the
// base-path handling is the real one), with the e2e harness page as the build entry. The harness
// stands in for the signed-in app, which needs Firebase auth. Nothing here ships.
import { mergeConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import appConfig from '../vite.config.js'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default async (env) => mergeConfig(await appConfig(env), {
  root: frontend,
  build: {
    outDir: process.env.E2E_SMOKE_OUT,
    emptyOutDir: true,
    rollupOptions: { input: path.join(frontend, 'e2e/harness/index.html') },
  },
})

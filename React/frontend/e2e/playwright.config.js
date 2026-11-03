import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const PYTHON = process.env.PYTHON || 'python3'
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 8000)
const VITE_PORT = Number(process.env.E2E_VITE_PORT || 5173)
// The analyzer runs on-device by default, so only the Vite server is needed. E2E_CLOUD=1 also starts the
// FastAPI backend and enables cloud.spec.js (the workflow through ?engine=cloud).
const CLOUD = process.env.E2E_CLOUD === '1'

export default defineConfig({
  testDir: here,
  globalSetup: path.join(here, 'global-setup.js'),
  testMatch: '**/*.spec.js',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    ...(CLOUD
      ? [{
          // FastAPI backend in local-dev mode (no Firebase token check, local result storage)
          command: `${PYTHON} -m uvicorn main:app --port ${BACKEND_PORT}`,
          cwd: path.resolve(here, '../../../cloudrun'),
          env: { LOCAL_DEV: 'true', PYTHONUNBUFFERED: '1' },
          url: `http://localhost:${BACKEND_PORT}/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        }]
      : []),
    {
      command: `npx vite --port ${VITE_PORT} --strictPort`,
      cwd: path.resolve(here, '..'),
      env: {
        VITE_API_PROXY_TARGET: `http://localhost:${BACKEND_PORT}`,
        VITE_FIREBASE_API_KEY: 'e2e-dummy',
        VITE_FIREBASE_AUTH_DOMAIN: 'e2e.example.com',
        VITE_FIREBASE_PROJECT_ID: 'e2e-dummy',
        VITE_FIREBASE_APP_ID: 'e2e-dummy',
      },
      url: `http://localhost:${VITE_PORT}/e2e/harness/index.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})

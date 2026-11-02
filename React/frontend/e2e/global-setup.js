// Playwright's webServer `url` check accepts any status from 200 to 403, so a 404 on /health
// would pass. Wait here until the backend really answers 200.
export default async function globalSetup() {
  const url = 'http://localhost:8000/health'
  const deadline = Date.now() + 120_000
  let last = 'no response'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status === 200) return
      last = `HTTP ${res.status}`
    } catch (err) {
      last = String(err)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Backend ${url} did not return 200 (last: ${last})`)
}

# Firebase / Pages Migration Notes

The React frontend now includes:

- GitHub Pages build/deploy scaffolding
- Firebase Auth Google sign-in
- single-email allowlist gating at app startup
- environment-based Firebase configuration
- Firestore-backed dashboard reads/writes with localStorage cache fallback

Current blocker for a full GitHub Pages migration:

- `AnalyzerApp` still depends on the Python `/api/upload`, `/api/analyze`, `/api/erase`, and `/api/histogram` endpoints.

Implication:

- GitHub Pages can host the dashboard shell and Firebase-authenticated dashboard flow.
- The particle analyzer still requires a separate backend until those API-dependent paths are replaced or moved to another hosted runtime.

Required GitHub Actions secrets:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_ALLOWED_EMAIL`

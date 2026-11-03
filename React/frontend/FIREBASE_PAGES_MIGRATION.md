# Firebase / Pages migration - completed

The migration is done. The app is a static React build on GitHub Pages, authenticated with Firebase Auth (Google sign-in, single allow-listed e-mail), with shots in Firestore and the particle analyzer served by a FastAPI service on Cloud Run.

Everything that used to be described here (secrets, deployment, backend setup) now lives in the root [README](../../README.md), sections "Architecture" and "Deployment".

Quick reference, GitHub Actions secrets used by `.github/workflows/deploy-pages.yml`:

- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`
- `VITE_ALLOWED_EMAIL`
- `VITE_API_BASE` (Cloud Run service URL)

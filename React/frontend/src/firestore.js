// Firestore is split out of firebase.js so the auth gate (main bundle) does not
// pull in the Firestore SDK; only the lazy dashboard chunk imports this file.
import { getFirestore } from 'firebase/firestore'
import { app } from './firebase'

export const db = getFirestore(app)

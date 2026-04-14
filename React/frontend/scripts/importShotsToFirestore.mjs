import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Papa from 'papaparse'
import admin from 'firebase-admin'

const cwd = process.cwd()
const csvPath = process.env.CSV_PATH
  ? path.resolve(cwd, process.env.CSV_PATH)
  : path.resolve(cwd, '../../Espresso Extraction TDS OrgCSV.csv')
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH
  ? path.resolve(cwd, process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH)
  : null

if (!serviceAccountPath) {
  throw new Error('Set FIREBASE_SERVICE_ACCOUNT_JSON_PATH to a Firebase service account JSON file.')
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const firestore = admin.firestore()

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function normalizeRow(row) {
  return {
    date: formatDate(row.Date),
    spray: String(row.Spray || '').trim(),
    avgGrind: String(row['Avg Grind'] || '').trim(),
    roaster: String(row.Roaster || '').trim(),
    region: String(row.Region || '').trim(),
    lat: toNumber(row.Lat),
    long: toNumber(row.Long),
    variety: String(row.Variety || '').trim(),
    processingTechnique: String(row['Processing Technique'] || '').trim(),
    elevation: String(row.Elevation || '').trim(),
    roast: String(row.Roast || '').trim(),
    notes: String(row.Notes || '').trim(),
    continent: String(row.Continent || '').trim(),
    brix: toNumber(row.Brix),
    ph: toNumber(row.pH),
    tempC: toNumber(row.TempC),
    adjustmentTemp: toNumber(row.AdjustmentTemp),
    adjustmentFactor: toNumber(row.AdjustmentFactor),
    tds: toNumber(row.TDS),
    dose: toNumber(row.Dose),
    grindSetting: String(row['Grind Setting'] || '').trim(),
    yieldGrams: toNumber(row.Yield),
    time: toNumber(row.Time),
    extraction: toNumber(row.Extraction),
    rating: toNumber(row.Rating) ?? 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

async function main() {
  const csvText = fs.readFileSync(csvPath, 'utf8')
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true })
  if (parsed.errors.length) {
    throw new Error(parsed.errors[0].message)
  }

  const rows = parsed.data.map(normalizeRow).filter((row) => row.date)
  console.log(`Importing ${rows.length} shots from ${csvPath}`)

  let batch = firestore.batch()
  let count = 0
  for (const row of rows) {
    const ref = firestore.collection('shots').doc()
    batch.set(ref, row)
    count += 1
    if (count % 400 === 0) {
      await batch.commit()
      batch = firestore.batch()
      console.log(`Committed ${count} shots...`)
    }
  }

  if (count % 400 !== 0) {
    await batch.commit()
  }

  console.log(`Done. Imported ${count} shots into shots collection.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

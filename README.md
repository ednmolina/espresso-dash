# Espresso Dashboard

This project combines two main tabs inside a single React workspace for tracking espresso shots and analyzing coffee grind images.

## Main Tabs

### Espresso Dashboard

The `Espresso Dashboard` tab is the logging and reporting side of the app. It loads shot data from Firebase, falls back to cached local data when Firebase is unavailable, and gives you a place to:

- log new espresso shots
- review performance metrics and trends
- explore coffee origins and filtering views
- run experiment comparisons against past shots
- refresh or export the shot dataset as CSV

### Particle Analyzer

The `Particle Analyzer` tab is the image-analysis workflow for coffee grounds. It lets you:

- upload a photo of grounds
- mark a known reference object for scale
- define an analysis region
- run particle detection
- erase unwanted clusters
- generate histograms and export particle data

## Project Structure

`React/` contains the authenticated React app with both tabs.

- `React/frontend` holds the Vite + React interface
- `React/backend` holds the FastAPI service used by the particle analyzer

The repository also includes the original Streamlit and Python analysis code used by earlier versions of the project.

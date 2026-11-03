// Tests for kernels.js / glibcPow.js / dataset.js.
// Expected values marked REF were produced by the Python implementation in
// cloudrun/coffeegrindsize_core (numba kernels) with the venv Python; the generating
// script is kept in the P1 builder scratchpad (gen_unit.py). They pin exact (===) parity.
import { describe, it, expect } from 'vitest'
import {
  growCluster, smoothedMax, pointsAlongPolygon, outlineMaskFromClusters, polygonMask,
  filterClusterPixels, detectCore, stableArgsortU8,
} from '../kernels.js'
import { pow2, powGlibc, fma, fmaExact } from '../glibcPow.js'
import { makeDataset, selectDataset, filterDatasetByClusterIds, dropPixels } from '../dataset.js'

const REF = {"polys": {"rect": {"shape": [50, 70], "pts": [[10, 10], [60, 10], [60, 40], [10, 40]], "count": 1530, "hash": 528115453}, "tri": {"shape": [50, 70], "pts": [[5, 5], [55, 35], [20, 45]], "count": 785, "hash": 3137690164}, "bowtie": {"shape": [40, 40], "pts": [[5, 5], [35, 35], [35, 5], [5, 35]], "count": 452, "hash": 3097207195}, "float": {"shape": [60, 80], "pts": [[3.5, 4.25], [70.1, 10.7], [66.6, 52.2], [20.3, 57.9], [8.8, 30.0]], "count": 2755, "hash": 2653406048}, "outside": {"shape": [30, 30], "pts": [[-10, -10], [50, -5], [40, 45], [-8, 40]], "count": 900, "hash": 1742780921}}, "pap": {"px": [28.0, 30.0, 45.0, 57.0, 2.0, 8.0, 49.0, 56.0, 14.0, 18.0, 52.0, 25.0, 16.0, 49.0, 15.0, 24.0, 38.0, 32.0, 5.0, 1.0, 51.0, 45.0, 50.0, 32.0, 49.0, 19.0, 27.0, 47.0, 7.0, 18.0, 7.0, 27.0, 58.0, 8.0, 22.0, 24.0, 54.0, 12.0, 30.0, 15.0, 1.0, 45.0, 3.0, 16.0, 29.0, 29.0, 7.0, 58.0, 44.0, 57.0, 5.0, 43.0, 17.0, 32.0, 55.0, 16.0, 43.0, 9.0, 19.0, 58.0, 25.0, 30.0, 17.0, 6.0, 25.0, 37.0, 27.0, 46.0, 21.0, 36.0, 46.0, 55.0, 25.0, 2.0, 43.0, 31.0, 52.0, 27.0, 22.0, 3.0, 27.0, 38.0, 46.0, 51.0, 12.0, 35.0, 48.0, 15.0, 20.0, 50.0, 34.0, 30.0, 40.0, 30.0, 58.0, 45.0, 3.0, 8.0, 32.0, 49.0, 4.0, 40.0, 45.0, 47.0, 52.0, 11.0, 33.0, 48.0, 21.0, 11.0, 28.0, 4.0, 13.0, 51.0, 40.0, 51.0, 50.0, 52.0, 18.0, 28.0, 37.0, 16.0, 55.0, 0.0, 50.0, 38.0, 15.0, 43.0, 24.0, 50.0, 59.0, 16.0, 28.0, 12.0, 41.0, 38.0, 50.0, 48.0, 58.0, 57.0, 53.0, 9.0, 2.0, 28.0, 20.0, 53.0, 47.0, 25.0, 34.0, 35.0, 53.0, 1.0, 29.0, 40.0, 27.0, 55.0, 57.0, 49.0, 27.0, 53.0, 4.0, 39.0, 16.0, 14.0, 40.0, 46.0, 53.0, 12.0, 52.0, 49.0, 18.0, 3.0, 46.0, 49.0, 27.0, 9.0, 8.0, 22.0, 45.0, 19.0, 1.0, 41.0, 44.0, 10.0, 33.0, 23.0, 30.0, 0.0, 38.0, 15.0, 33.0, 25.0, 36.0, 6.0, 21.0, 37.0, 46.0, 22.0, 1.0, 43.0, 30.0, 39.0, 9.0, 25.0, 53.0, 52.0, 18.0, 37.0, 5.0, 48.0, 16.0, 20.0, 57.0, 32.0, 52.0, 11.0, 45.0, 59.0, 4.0, 14.0, 8.0, 15.0, 18.0, 4.0, 53.0, 15.0, 55.0, 45.0, 10.0, 41.0, 46.0, 7.0, 7.0, 22.0, 4.0, 25.0, 28.0, 39.0, 34.0, 27.0, 13.0, 35.0, 27.0, 50.0, 41.0, 43.0, 34.0, 21.0, 16.0, 26.0, 34.0, 22.0, 8.0, 6.0, 2.0, 12.0, 24.0, 17.0, 10.0, 18.0, 42.0, 18.0, 55.0, 34.0, 8.0, 58.0, 52.0, 46.0, 9.0, 47.0, 42.0, 45.0, 42.0, 35.0, 20.0, 55.0, 58.0, 41.0, 21.0, 30.0, 33.0, 4.0, 5.0, 29.0, 33.0, 12.0, 15.0, 7.0, 54.0, 30.0, 16.0, 47.0, 57.0, 17.0, 53.0, 46.0, 47.0, 31.0, 54.0, 8.0, 5.0, 57.0, 29.0, 24.0, 43.0, 17.0, 38.0, 50.0, 48.0, 7.0, 58.0, 44.0, 41.0, 11.0, 55.0, 23.0, 56.0, 13.0, 5.0, 50.0, 35.0, 23.0, 58.0, 58.0, 0.0, 37.0, 48.0, 41.0, 36.0, 31.0, 32.0, 18.0, 8.0, 23.0, 41.0, 56.0, 57.0, 12.0, 1.0, 59.0, 40.0, 45.0, 48.0, 21.0, 51.0, 38.0, 38.0, 22.0, 20.0, 22.0, 42.0, 30.0, 1.0, 1.0, 11.0, 29.0, 35.0, 58.0, 46.0, 17.0, 30.0, 44.0, 53.0, 26.0, 42.0, 12.0, 27.0, 54.0, 22.0, 1.0, 47.0, 18.0, 26.0, 59.0, 23.0, 15.0, 14.0, 50.0, 12.0, 36.0, 14.0, 48.0, 43.0, 37.0, 25.0, 21.0, 56.0, 45.0, 23.0, 1.0, 7.0, 26.0, 27.0, 22.0, 59.0, 28.0, 47.0, 7.0, 22.0, 13.0], "py": [7.0, 28.0, 7.0, 19.0, 34.0, 39.0, 27.0, 30.0, 14.0, 43.0, 9.0, 36.0, 4.0, 30.0, 12.0, 14.0, 17.0, 39.0, 39.0, 12.0, 26.0, 3.0, 44.0, 48.0, 18.0, 27.0, 26.0, 38.0, 3.0, 26.0, 42.0, 30.0, 27.0, 1.0, 46.0, 9.0, 17.0, 33.0, 23.0, 28.0, 29.0, 7.0, 0.0, 47.0, 40.0, 7.0, 33.0, 25.0, 36.0, 7.0, 35.0, 35.0, 49.0, 13.0, 21.0, 6.0, 0.0, 2.0, 22.0, 8.0, 37.0, 9.0, 31.0, 26.0, 16.0, 22.0, 49.0, 47.0, 13.0, 47.0, 10.0, 39.0, 17.0, 33.0, 32.0, 42.0, 19.0, 46.0, 43.0, 1.0, 4.0, 5.0, 32.0, 18.0, 7.0, 4.0, 45.0, 29.0, 1.0, 13.0, 32.0, 13.0, 38.0, 14.0, 31.0, 4.0, 40.0, 37.0, 26.0, 32.0, 3.0, 30.0, 22.0, 1.0, 1.0, 21.0, 36.0, 34.0, 8.0, 7.0, 12.0, 19.0, 6.0, 0.0, 18.0, 4.0, 9.0, 10.0, 19.0, 20.0, 2.0, 23.0, 45.0, 44.0, 6.0, 15.0, 32.0, 1.0, 28.0, 41.0, 39.0, 3.0, 13.0, 4.0, 25.0, 48.0, 39.0, 37.0, 37.0, 16.0, 48.0, 6.0, 6.0, 19.0, 23.0, 16.0, 23.0, 43.0, 23.0, 20.0, 31.0, 4.0, 44.0, 46.0, 1.0, 31.0, 49.0, 5.0, 7.0, 5.0, 45.0, 23.0, 47.0, 4.0, 34.0, 31.0, 26.0, 30.0, 6.0, 1.0, 30.0, 40.0, 44.0, 39.0, 23.0, 45.0, 1.0, 33.0, 25.0, 34.0, 43.0, 8.0, 38.0, 1.0, 22.0, 3.0, 12.0, 48.0, 20.0, 32.0, 47.0, 47.0, 4.0, 17.0, 49.0, 37.0, 21.0, 3.0, 32.0, 8.0, 45.0, 13.0, 22.0, 27.0, 24.0, 27.0, 40.0, 24.0, 16.0, 21.0, 39.0, 28.0, 23.0, 48.0, 12.0, 22.0, 47.0, 41.0, 28.0, 2.0, 27.0, 19.0, 48.0, 28.0, 28.0, 31.0, 20.0, 12.0, 25.0, 19.0, 41.0, 47.0, 23.0, 32.0, 9.0, 29.0, 7.0, 3.0, 10.0, 2.0, 43.0, 10.0, 45.0, 6.0, 33.0, 49.0, 5.0, 0.0, 14.0, 18.0, 24.0, 2.0, 3.0, 32.0, 4.0, 2.0, 19.0, 3.0, 7.0, 3.0, 24.0, 13.0, 41.0, 28.0, 16.0, 40.0, 9.0, 13.0, 6.0, 14.0, 20.0, 41.0, 18.0, 37.0, 42.0, 6.0, 36.0, 40.0, 17.0, 41.0, 40.0, 8.0, 8.0, 31.0, 20.0, 9.0, 48.0, 12.0, 8.0, 24.0, 18.0, 26.0, 16.0, 23.0, 23.0, 27.0, 45.0, 10.0, 20.0, 38.0, 45.0, 13.0, 47.0, 45.0, 13.0, 25.0, 35.0, 15.0, 11.0, 8.0, 23.0, 24.0, 36.0, 18.0, 24.0, 31.0, 37.0, 24.0, 9.0, 1.0, 25.0, 41.0, 28.0, 2.0, 5.0, 41.0, 15.0, 40.0, 8.0, 46.0, 8.0, 33.0, 22.0, 8.0, 16.0, 22.0, 11.0, 21.0, 6.0, 31.0, 47.0, 19.0, 22.0, 33.0, 46.0, 10.0, 7.0, 17.0, 47.0, 27.0, 3.0, 21.0, 48.0, 6.0, 11.0, 48.0, 2.0, 34.0, 26.0, 41.0, 45.0, 17.0, 15.0, 47.0, 30.0, 40.0, 1.0, 48.0, 21.0, 9.0, 32.0, 23.0, 36.0, 19.0, 14.0, 30.0, 45.0, 12.0, 31.0, 5.0, 8.0, 23.0, 3.0, 31.0, 28.0, 19.0, 37.0, 49.0, 46.0, 20.0, 30.0, 14.0, 4.0, 40.0, 20.0, 23.0, 20.0, 13.0, 35.0, 14.0], "n1": 46, "h1": 4049130103, "n2": 54, "h2": 4236726667}, "smax": [{"w": 1, "v": 0.9916861960144647}, {"w": 2, "v": 1.9088925374041605}, {"w": 3, "v": 2.5861489308714636}, {"w": 4, "v": 2.8753115421011315}, {"w": 5, "v": 3.5452664540408962}, {"w": 7, "v": 4.173427596152209}], "smax_vals": [0.9471557892442384, 0.961736748159922, 0.6462368962429871, 0.2787679766747637, 0.7113690437189849, 0.2167694819361088, 0.3220846874139359, 0.5417363597027655, 0.40114416116454565, 0.35102386263458685, 0.9741344294864881, 0.17020617447974906, 0.6137785589494178, 0.03854138948384955, 0.09171473713390443, 0.20999600501172455, 0.9916861960144647, 0.7264246392278, 0.8680380956291989, 0.049483784636716543, 0.6814384526526729, 0.4399364794360058, 0.41641994855534936, 0.7082547942479717, 0.30831895053558056, 0.5134678232710247, 0.2607247218237164, 0.39140407059240856, 0.5333261752047522, 0.15788100282626316, 0.27618712190520356, 0.4204059052215403, 0.4727479785281554, 0.8000039680110183, 0.6429501138675994, 0.5624900665221173, 0.8698673937003966], "core": {"h": 40, "w": 50, "blue": "3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzcMjIyMjLc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NwyMjIyMtzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3DIyMjIy3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzcMjIyMjLc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NwyMjIyMtzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzcPD0+P0A8PT4/QDw93Nzc3Nzc3Nzc3Dw8PDw8PDw8PDzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nw9Pj9APD0+P0A8PT7c3Nzc3Nzc3NzcPDw8PDw8PDw8PNzc3Nzc3Nzc3Nzc3Nzc3Nzc3D4/QDw9Pj9APD0+P9zc3Nzc3Nzc3Nw8PDw8PDw8PDw83Nzc3Nzc3Nzc3Nzc3Nzc3NzcP0A8PT4/QDw9Pj9A3Nzc3Nzc3Nzc3Dw8PDw8PDw8PDzc3Nzc3Nzc3Nzc3Nzc3Nzc3NxAPD0+P0A8PT4/QDw8PDw8PDw8PDw8PDw8PDw8PDw8PNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Dw9Pj9APD0+P0A8PTw8PDw8PDw8PDw8PDw8PDw8PDw83Nzc3Nzc3Nzc3Nzc3Nzc3NzcPT4/QDw9Pj9APD0+PDw8PDw8PDw8PDw8PDw8PDw8PDzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nw+P0A8PT4/QDw9Pj88PDw8PDw8PDw8PDw8PDw8PDw8PNzc3Nzc3Nzc3Nzc3Nzc3Nzc3D9APD0+P0A8PT4/QNzc3Nzc3Nzc3Nw8PDw8PDw8PDw83Nzc3Nzc3Nzc3Nzc3Nzc3NzcQDw9Pj9APD0+P0A83Nzc3Nzc3Nzc3Dw8PDw8PDw8PDzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nw8PT4/QDw9Pj9APD3c3Nzc3Nzc3NzcPDw8PDw8PDw8PNzc3Nzc3Nzc3Nzc3Nzc3Nzc3D0+P0A8PT4/QDw9Ptzc3Nzc3Nzc3Nw8PDw8PDw8PDw83Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NxQUFDc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NxGRkZGRkbc3Nzc3FBQUNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3EZGRkZGRtzc3NzcUFBQ3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzcRkZGRkZG3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NxGRkZGRkbc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3EZGRkZGRtzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzcRkZGRkZG3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NxGRkZGRkbc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3EZGRkZGRtzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nw=", "cases": [{"quick": false, "sm": 3, "ma": 100.0, "ms": 5.0, "mc": 0.35, "bg": 220.0, "ids": [0, 1, 3], "stats": [[25.0, 0.9947183943243456, 2.8134884879909565, 2.8284271247461903, 70.33721219977392, 4.0, 46.0], [304.0, 0.3471718004716129, 5.796076065190967, 16.695123444119975, 1762.0071238180537, 13.5, 23.236842105263158], [9.0, 1.4323944878270576, 2.025711711353489, 1.4142135623730951, 18.2314054021814, 31.0, 6.0]], "off": [0, 25, 329, 338], "pr_hash": 2405383538, "pc_hash": 444207569, "n_pix": 338}, {"quick": false, "sm": 1, "ma": 100.0, "ms": 1.0, "mc": 0.35, "bg": 220.0, "ids": [0, 1, 3], "stats": [[25.0, 0.9947183943243456, 2.8134884879909565, 2.8284271247461903, 70.33721219977392, 4.0, 46.0], [304.0, 0.3471718004716129, 5.796076065190967, 16.695123444119975, 1762.0071238180537, 13.5, 23.236842105263158], [9.0, 1.4323944878270576, 2.025711711353489, 1.4142135623730951, 18.2314054021814, 31.0, 6.0]], "off": [0, 25, 329, 338], "pr_hash": 2405383538, "pc_hash": 444207569, "n_pix": 338}, {"quick": false, "sm": 5, "ma": 7.0, "ms": 3.0, "mc": 0.35, "bg": 220.0, "ids": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13], "stats": [[25.0, 0.9947183943243456, 2.8134884879909565, 2.8284271247461903, 70.33721219977392, 4.0, 46.0], [45.0, 0.5563844086950285, 2.8230514698242324, 5.073922679547324, 127.03731614209045, 10.71111111111111, 10.71111111111111], [46.0, 0.5254563985073173, 2.7737819767524634, 5.278805215108322, 127.59397093061332, 11.565217391304348, 17.73913043478261], [57.0, 0.41027813719400585, 2.7283600326521302, 6.650025398165408, 155.5165218611714, 11.157894736842104, 31.596491228070175], [26.0, 0.5285417628310165, 2.0914688086660878, 3.957054968492177, 54.37818902531828, 11.692307692307692, 37.57692307692308], [21.0, 0.24026961088500173, 1.2673137111144976, 5.2745484809606715, 26.61358793340445, 14.380952380952381, 23.761904761904763], [51.0, 0.6392848447692777, 3.221494217758909, 5.03921568627451, 164.29620510570436, 16.627450980392158, 13.0], [48.0, 0.6130174476767566, 3.0604275309074023, 4.992398735967402, 146.9005214835553, 16.979166666666668, 34.416666666666664], [6.0, 0.8594366926962357, 1.2811725781509191, 1.4907119849998591, 7.6870354689055125, 18.333333333333332, 18.333333333333332], [3.0, 1.7188733853924634, 1.2811725781509165, 0.7453559924999312, 3.843517734452749, 18.666666666666668, 8.333333333333334], [9.0, 1.4323944878270576, 2.025711711353489, 1.4142135623730951, 18.2314054021814, 31.0, 6.0]], "off": [0, 25, 70, 116, 173, 199, 220, 271, 319, 325, 328, 337], "pr_hash": 1852155585, "pc_hash": 1489048886, "n_pix": 337}, {"quick": false, "sm": 3, "ma": 100.0, "ms": 5.0, "mc": 0.02, "bg": 220.0, "ids": [0, 1, 3], "stats": [[25.0, 0.9947183943243456, 2.8134884879909565, 2.8284271247461903, 70.33721219977392, 4.0, 46.0], [304.0, 0.3471718004716129, 5.796076065190967, 16.695123444119975, 1762.0071238180537, 13.5, 23.236842105263158], [9.0, 1.4323944878270576, 2.025711711353489, 1.4142135623730951, 18.2314054021814, 31.0, 6.0]], "off": [0, 25, 329, 338], "pr_hash": 2405383538, "pc_hash": 444207569, "n_pix": 338}, {"quick": true, "sm": 3, "ma": 100.0, "ms": 5.0, "mc": 0.35, "bg": 220.0, "ids": [0, 1, 3], "stats": [[25.0, 0.9947183943243456, 2.8134884879909565, 2.8284271247461903, 70.33721219977392, 4.0, 46.0], [304.0, 0.3471718004716129, 5.796076065190967, 16.695123444119975, 1762.0071238180537, 13.5, 23.236842105263158], [9.0, 1.4323944878270576, 2.025711711353489, 1.4142135623730951, 18.2314054021814, 31.0, 6.0]], "off": [0, 25, 329, 338], "pr_hash": 677358050, "pc_hash": 4003402161, "n_pix": 338}, {"quick": true, "sm": 1, "ma": 100.0, "ms": 1.0, "mc": 0.35, "bg": 220.0, "ids": [0, 1, 3], "stats": [[25.0, 0.9947183943243456, 2.8134884879909565, 2.8284271247461903, 70.33721219977392, 4.0, 46.0], [304.0, 0.3471718004716129, 5.796076065190967, 16.695123444119975, 1762.0071238180537, 13.5, 23.236842105263158], [9.0, 1.4323944878270576, 2.025711711353489, 1.4142135623730951, 18.2314054021814, 31.0, 6.0]], "off": [0, 25, 329, 338], "pr_hash": 677358050, "pc_hash": 4003402161, "n_pix": 338}, {"quick": true, "sm": 5, "ma": 7.0, "ms": 3.0, "mc": 0.35, "bg": 220.0, "ids": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13], "stats": [[25.0, 0.9947183943243456, 2.8134884879909565, 2.8284271247461903, 70.33721219977392, 4.0, 46.0], [45.0, 0.5563844086950285, 2.8230514698242324, 5.073922679547324, 127.03731614209045, 10.71111111111111, 10.71111111111111], [46.0, 0.5254563985073173, 2.7737819767524634, 5.278805215108322, 127.59397093061332, 11.565217391304348, 17.73913043478261], [57.0, 0.41027813719400585, 2.7283600326521302, 6.650025398165408, 155.5165218611714, 11.157894736842104, 31.596491228070175], [26.0, 0.5285417628310165, 2.0914688086660878, 3.957054968492177, 54.37818902531828, 11.692307692307692, 37.57692307692308], [21.0, 0.24026961088500173, 1.2673137111144976, 5.2745484809606715, 26.61358793340445, 14.380952380952381, 23.761904761904763], [51.0, 0.6392848447692777, 3.221494217758909, 5.03921568627451, 164.29620510570436, 16.627450980392158, 13.0], [48.0, 0.6130174476767566, 3.0604275309074023, 4.992398735967402, 146.9005214835553, 16.979166666666668, 34.416666666666664], [6.0, 0.8594366926962357, 1.2811725781509191, 1.4907119849998591, 7.6870354689055125, 18.333333333333332, 18.333333333333332], [3.0, 1.7188733853924634, 1.2811725781509165, 0.7453559924999312, 3.843517734452749, 18.666666666666668, 8.333333333333334], [9.0, 1.4323944878270576, 2.025711711353489, 1.4142135623730951, 18.2314054021814, 31.0, 6.0]], "off": [0, 25, 70, 116, 173, 199, 220, 271, 319, 325, 328, 337], "pr_hash": 1148693809, "pc_hash": 2232484822, "n_pix": 337}, {"quick": true, "sm": 3, "ma": 100.0, "ms": 5.0, "mc": 0.02, "bg": 220.0, "ids": [0, 1, 3], "stats": [[25.0, 0.9947183943243456, 2.8134884879909565, 2.8284271247461903, 70.33721219977392, 4.0, 46.0], [304.0, 0.3471718004716129, 5.796076065190967, 16.695123444119975, 1762.0071238180537, 13.5, 23.236842105263158], [9.0, 1.4323944878270576, 2.025711711353489, 1.4142135623730951, 18.2314054021814, 31.0, 6.0]], "off": [0, 25, 329, 338], "pr_hash": 677358050, "pc_hash": 4003402161, "n_pix": 338}]}, "grow": {"first": 0, "n": 25, "hash": 3898101613, "head": [0, 1, 5, 2, 6, 10, 3, 7, 11, 15, 4, 8]}, "pow": [[49.000239791967545, 2401.02349967032, 117650.72722999477, 3.6593116792113025], [47.44220462717111, 2250.762779886376, 106781.14837058992, 3.620108780222977], [6.466642998469497, 41.81747166965456, 270.4186603862682, 1.8630576560881478], [32.37248568891084, 1047.9778296787372, 33925.647293570764, 3.187073034744629], [33.839037291205315, 1145.0804447955838, 38748.41987286774, 3.234491391913895], [17.462335654361326, 304.93316650557875, 5324.845305667667, 2.594383123620701], [24.790005566247018, 614.5443759745582, 15234.558501115096, 2.915807674898485], [20.664978114743047, 427.04132048280906, 8824.799541868222, 2.744174029378949], [36.77896572342995, 1352.6923196852351, 49750.6244600502, 3.3255731417728995], [31.437576467563485, 988.3212141539015, 31070.423744478463, 3.156092231527855], [29.71954556911306, 883.2513888345876, 26249.829899451925, 3.097519540911402], [2.5344703913631417, 6.423540164696437, 16.280272355155038, 1.363418159146707], [23.777585032944316, 565.3735499988975, 13443.21766047638, 2.875560975668692], [11.833690943938294, 140.0362413566472, 1657.1456011653129, 2.2788027817319616], [43.59089410143452, 1900.166048562479, 82829.93699802831, 3.519372684929888], [49.26736432774491, 2427.273187802751, 119585.35246644494, 3.665949204754692], [14.938725206800989, 223.16551080431123, 3333.8082415409826, 2.4628493438218797], [46.571555452860885, 2168.909777298896, 101009.5019657277, 3.597826760675362], [41.233593493030526, 1700.2092323484894, 70105.7363397551, 3.4547534697880584], [31.859254514780993, 1015.012098237593, 32337.528773333364, 3.1701406895793394], [26.225413399720054, 687.7723079862162, 18037.1131018181, 2.9710328082314024], [14.14339588836381, 200.0356472549863, 2829.1833509123667, 2.4183430070618726], [47.578470743852854, 2263.7108783236617, 107703.90179686379, 3.623571425834152], [5.63200822030178, 31.719516593546825, 178.64457819885445, 1.7791849380699696], [29.93536447118087, 896.1260460224379, 26825.859799799877, 3.104999372341191], [40.5481124590364, 1644.1494239906633, 66667.15574343334, 3.4355020664865896], [45.08599270328565, 2032.7467380407268, 91648.4045989319, 3.5591575433429274], [27.442832591620515, 753.1090606517091, 20667.445874697434, 3.016312348760169], [44.24791013869707, 1957.877551642211, 86631.9899676368, 3.53696629392365], [20.834530272217744, 434.07765166395757, 9043.803974085913, 2.7516587358046065], [48.107831834710325, 2314.363483836768, 111339.00928481357, 3.636960587074093], [34.64722682906798, 1200.430326944888, 41591.58183015178, 3.260039231623801], [34.84101794829669, 1213.8965316735319, 42293.39084741263, 3.2661060223045264], [5.951345915282022, 35.418518203344, 210.78785363481327, 1.8121955708731297], [45.41313001722886, 2062.3523779617326, 93657.87668171729, 3.567745047571313], [22.53012894130167, 507.60671011167904, 11436.444630286067, 2.8243676321296567], [45.29254325926644, 2051.414474892522, 92913.77884675488, 3.564584403903374], [22.13437040718157, 489.9303533223152, 10844.299914157466, 2.8077324702229762], [21.46170290626642, 460.6046916368445, 9885.361049142415, 2.7789968822866], [6.137545320386515, 37.669462559798404, 231.19803365536575, 1.830901177611542]]}

const fnv = (arr) => {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  let h = 2166136261
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619) >>> 0
  return h
}

// cluster dataset from a list of [rows[], cols[]]
function clustersDs(list) {
  const n = list.length
  const px_start = new Int32Array(n)
  const px_len = new Int32Array(n)
  const rows = []
  const cols = []
  list.forEach(([r, c], k) => {
    px_start[k] = rows.length
    px_len[k] = r.length
    rows.push(...r)
    cols.push(...c)
  })
  return makeDataset({ n, px_start, px_len, px_row: Int32Array.from(rows), px_col: Int32Array.from(cols) })
}

function square(r0, c0, n) {
  const r = []
  const c = []
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { r.push(r0 + i); c.push(c0 + j) }
  return [r, c]
}

const sum = (a) => a.reduce((s, v) => s + v, 0)

describe('outlineMaskFromClusters (ports tests/core/test_kernels.py)', () => {
  it('5x5 square is a 16 px ring', () => {
    const out = outlineMaskFromClusters(20, 20, clustersDs([square(5, 5, 5)]))
    expect(sum(out)).toBe(16)
    expect(out[7 * 20 + 7]).toBe(0)
    expect(out[5 * 20 + 5]).toBe(1)
    expect(out[9 * 20 + 9]).toBe(1)
    expect(out[5 * 20 + 7]).toBe(1)
  })
  it('two touching squares keep their own borders', () => {
    const out = outlineMaskFromClusters(20, 30, clustersDs([square(5, 5, 5), square(5, 10, 5)]))
    expect(sum(out)).toBe(32)
  })
  it('image edge counts as outside', () => {
    expect(sum(outlineMaskFromClusters(10, 10, clustersDs([square(0, 0, 4)])))).toBe(12)
  })
  it('empty dataset', () => {
    expect(sum(outlineMaskFromClusters(8, 8, clustersDs([])))).toBe(0)
  })
  it('pixel count equals the label-grid reference on random disjoint blobs', () => {
    // brute force 8-neighbour test on an explicit label grid
    const h = 40
    const w = 50
    let seed = 12345
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296 }
    const label = new Int32Array(h * w).fill(-1)
    const list = []
    for (let k = 0; k < 12; k++) {
      const r0 = Math.floor(rnd() * (h - 8))
      const c0 = Math.floor(rnd() * (w - 8))
      const rr = []
      const cc = []
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
        if (rnd() < 0.8 && label[(r0 + i) * w + c0 + j] < 0) {
          label[(r0 + i) * w + c0 + j] = k
          rr.push(r0 + i)
          cc.push(c0 + j)
        }
      }
      if (rr.length) list.push([rr, cc])
    }
    // relabel to dataset positions
    const lab2 = new Int32Array(h * w).fill(-1)
    list.forEach(([rr, cc], p) => rr.forEach((r, i) => { lab2[r * w + cc[i]] = p }))
    const expected = new Uint8Array(h * w)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const lab = lab2[r * w + c]
      if (lab < 0) continue
      let edge = false
      for (let dr = -1; dr <= 1 && !edge; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r2 = r + dr
        const c2 = c + dc
        if (r2 < 0 || r2 >= h || c2 < 0 || c2 >= w || lab2[r2 * w + c2] !== lab) { edge = true; break }
      }
      expected[r * w + c] = edge ? 1 : 0
    }
    expect(Array.from(outlineMaskFromClusters(h, w, clustersDs(list)))).toEqual(Array.from(expected))
  })
})

describe('polygonMask', () => {
  const run = (shape, pts) => polygonMask(shape[0], shape[1], Float64Array.from(pts.map((p) => p[0])), Float64Array.from(pts.map((p) => p[1])))
  for (const [name, c] of Object.entries(REF.polys)) {
    it(`${name} matches Python (count and hash, REF)`, () => {
      const m = run(c.shape, c.pts)
      expect(sum(m)).toBe(c.count)
      expect(fnv(m)).toBe(c.hash)
    })
  }
  it('axis-aligned rectangle with integer vertices follows the matplotlib boundary rule (REF)', () => {
    // Python: rows 11..40 and columns 10..60 are inside (top row/right column excluded, left/bottom included)
    const m = run([50, 70], [[10, 10], [60, 10], [60, 40], [10, 40]])
    expect(sum(m)).toBe(1530)
    expect(m[10 * 70 + 10]).toBe(0)
    expect(m[11 * 70 + 10]).toBe(1)
    expect(m[11 * 70 + 9]).toBe(0)
    expect(m[40 * 70 + 60]).toBe(1)
    expect(m[41 * 70 + 60]).toBe(0)
    expect(m[40 * 70 + 61]).toBe(0)
  })
  it('bow-tie polygon: even-odd fill keeps the left/right wedges, not the top/bottom ones (REF)', () => {
    const m = run([40, 40], [[5, 5], [35, 35], [35, 5], [5, 35]])
    expect(m[20 * 40 + 8]).toBe(1) // left wedge
    expect(m[20 * 40 + 32]).toBe(1) // right wedge
    expect(m[8 * 40 + 20]).toBe(0) // top wedge
    expect(m[32 * 40 + 20]).toBe(0) // bottom wedge
  })
  it('polygon far outside the image still fills correctly clipped', () => {
    const m = run([30, 30], [[-10, -10], [50, -5], [40, 45], [-8, 40]])
    expect(sum(m)).toBe(900)
  })
})

describe('pointsAlongPolygon', () => {
  it('matches Python flags (REF)', () => {
    const { px, py } = REF.pap
    const x = Float64Array.from(px)
    const y = Float64Array.from(py)
    const r1 = pointsAlongPolygon(x, y, x.length, Float64Array.from([10, 60, 60, 10, 10]), Float64Array.from([10, 10, 40, 40, 10]))
    expect(sum(r1)).toBe(REF.pap.n1)
    expect(fnv(r1)).toBe(REF.pap.h1)
    const r2 = pointsAlongPolygon(x, y, x.length, Float64Array.from([5, 55.5, 20.25, 5]), Float64Array.from([5, 35.5, 45, 5]))
    expect(sum(r2)).toBe(REF.pap.n2)
    expect(fnv(r2)).toBe(REF.pap.h2)
  })
  it('zero-length segments give NaN distances: NaN > thresh is false, so only coincident points trigger (REF)', () => {
    const r = pointsAlongPolygon(Float64Array.from([3, 4, 3]), Float64Array.from([3, 3, 5]), 3, Float64Array.from([3, 3]), Float64Array.from([3, 3]))
    expect(Array.from(r)).toEqual([1, 0, 0])
  })
  it('only the first n points are examined', () => {
    const r = pointsAlongPolygon(Float64Array.from([0, 0, 0]), Float64Array.from([0, 0, 0]), 2, Float64Array.from([0, 5]), Float64Array.from([0, 0]))
    expect(r.length).toBe(2)
    expect(Array.from(r)).toEqual([1, 1])
  })
})

describe('smoothedMax', () => {
  it('equals max of an in-order naive convolve (same summation order)', () => {
    const vals = Float64Array.from(REF.smax_vals)
    for (const w of [1, 2, 3, 4, 5, 7]) {
      const inv = 1.0 / w
      const n = vals.length
      let best = -Infinity
      const off = Math.floor((w - 1) / 2)
      for (let i = 0; i < n; i++) {
        let acc = 0
        for (let j = Math.max(i + off - w + 1, 0); j <= Math.min(i + off, n - 1); j++) acc += vals[j] * inv
        acc *= w
        if (acc > best) best = acc
      }
      expect(smoothedMax(vals, n, w)).toBe(best)
    }
  })
  it('matches numba _smoothed_max bit for bit (REF)', () => {
    const vals = Float64Array.from(REF.smax_vals)
    for (const c of REF.smax) expect(smoothedMax(vals, vals.length, c.w)).toBe(c.v)
  })
  it('honours n smaller than the buffer', () => {
    const vals = Float64Array.from([1, 5, 2, 100, 100])
    expect(smoothedMax(vals, 3, 2)).toBeLessThan(10)
  })
})

describe('stableArgsortU8', () => {
  it('sorts ascending and keeps ties in original order', () => {
    const v = Uint8Array.from([5, 1, 5, 0, 1, 255, 0, 5])
    expect(Array.from(stableArgsortU8(v, v.length))).toEqual([3, 6, 1, 4, 0, 2, 7, 5])
  })
  it('equals a comparator sort with index tie-break on random data', () => {
    let s = 7
    const v = new Uint8Array(5000)
    for (let i = 0; i < v.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v[i] = (s >>> 24) % 17 }
    const ref = Array.from(v, (x, i) => i).sort((a, b) => v[a] - v[b] || a - b)
    expect(Array.from(stableArgsortU8(v, v.length))).toEqual(ref)
  })
  it('respects n', () => {
    expect(Array.from(stableArgsortU8(Uint8Array.from([3, 2, 1, 0]), 3))).toEqual([2, 1, 0])
  })
})

// --------------------------------------------------------------- detect core on the Python fixture
function coreInputs(ref) {
  const blue = Uint8Array.from(Buffer.from(ref.blue, 'base64'))
  const { h, w } = ref
  const rows = []
  const cols = []
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (blue[r * w + c] < 140) { rows.push(r); cols.push(c) }
  const n = rows.length
  const order = stableArgsortU8(Uint8Array.from(rows.map((r, i) => blue[r * w + cols[i]])), n)
  const rowPos = Int32Array.from(order, (i) => rows[i])
  const colPos = Int32Array.from(order, (i) => cols[i])
  const bs = Uint8Array.from(order, (i) => blue[rows[i] * w + cols[i]])
  const ig = new Int32Array(h * w).fill(-1)
  for (let i = 0; i < n; i++) ig[rowPos[i] * w + colPos[i]] = i
  return { h, w, n, rowPos, colPos, bs, ig }
}

describe('growCluster / detectCore vs Python (REF)', () => {
  const ref = REF.core
  const inp = coreInputs(ref)
  it('growCluster BFS order from the darkest pixel', () => {
    const { n, ig, rowPos, colPos, h, w } = inp
    const out = new Int32Array(n)
    const queue = new Int32Array(n)
    const nf = growCluster(ig, h, w, new Uint8Array(n), rowPos, colPos, 0, 100 * 100, new Int32Array(n), 1, out, queue)
    expect(nf).toBe(REF.grow.n)
    expect(Array.from(out.subarray(0, 12))).toEqual(REF.grow.head)
    expect(fnv(out.slice(0, nf))).toBe(REF.grow.hash)
  })
  ref.cases.forEach((c, k) => {
    it(`detectCore case ${k} (quick=${c.quick}, window=${c.sm}, axis=${c.ma}, min=${c.ms}, cost=${c.mc})`, () => {
      const { n, ig, rowPos, colPos, bs, h, w } = inp
      const res = detectCore(ig, h, w, rowPos, colPos, bs, n, c.bg, 0.4, c.mc, c.sm, c.ma, c.ms, c.quick, null)
      expect(Array.from(res.ids)).toEqual(c.ids)
      expect(Array.from(res.offsets)).toEqual(c.off)
      expect(res.pixRow.length).toBe(c.n_pix)
      expect(fnv(res.pixRow)).toBe(c.pr_hash)
      expect(fnv(res.pixCol)).toBe(c.pc_hash)
      for (let i = 0; i < c.ids.length; i++) {
        for (let j = 0; j < 7; j++) expect(res.stats[i * 7 + j]).toBe(c.stats[i][j])
      }
    })
  })
  it('does not mutate the index grid or inputs and reports progress', () => {
    const { n, ig, rowPos, colPos, bs, h, w } = inp
    const before = ig.slice()
    const seen = []
    detectCore(ig, h, w, rowPos, colPos, bs, n, ref.cases[0].bg, 0.4, 0.35, 3, 100, 5, false, null, (open, tot) => seen.push([open, tot]))
    expect(Array.from(ig)).toEqual(Array.from(before))
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0][1]).toBe(n)
  })
})

describe('filterClusterPixels', () => {
  it('accepts a straight dark bar and rejects pixels behind a bright gap', () => {
    // 1 x 11 strip; gap of bright pixels in the middle breaks the path to the dark reference
    const w = 11
    const rowPos = new Int32Array(w).fill(5)
    const colPos = Int32Array.from({ length: w }, (_, i) => i)
    const blue = Uint8Array.from([40, 40, 40, 40, 40, 200, 200, 200, 40, 40, 40])
    const ci = Int32Array.from({ length: w }, (_, i) => i) // already sorted by distance from pixel 0
    const { acc, nAcc } = filterClusterPixels(ci, w, rowPos, colPos, blue, 230, 0.4, 0.35, 3, {})
    expect(Array.from(acc.subarray(0, nAcc))).toEqual([0, 1, 2, 3, 4])
  })
  it('scratch buffers are reusable across calls with different sizes', () => {
    const scratch = {}
    const mk = (len) => {
      const rowPos = new Int32Array(len).fill(3)
      const colPos = Int32Array.from({ length: len }, (_, i) => i)
      const blue = new Uint8Array(len).fill(50)
      const ci = Int32Array.from({ length: len }, (_, i) => i)
      return filterClusterPixels(ci, len, rowPos, colPos, blue, 230, 0.4, 0.35, 3, scratch).nAcc
    }
    expect(mk(30)).toBe(30)
    expect(mk(5)).toBe(5)
    expect(mk(80)).toBe(80)
  })
})

describe('glibcPow (bit-exact libm pow)', () => {
  it('reproduces Python x**2, x**3, x**(1/3) on inputs where x*x differs (REF)', () => {
    for (const [x, p2, p3, pc] of REF.pow) {
      expect(x * x).not.toBe(p2) // the cases that motivate this module
      expect(pow2(x)).toBe(p2)
      expect(powGlibc(x, 2)).toBe(p2)
      expect(powGlibc(x, 3)).toBe(p3)
      expect(powGlibc(x, 1 / 3)).toBe(pc)
    }
  })
  it('pow2 equals x*x when no tie is near and falls back for odd inputs', () => {
    expect(pow2(3)).toBe(9)
    expect(pow2(0)).toBe(0)
    expect(pow2(1e-200)).toBe(0)
    expect(pow2(Infinity)).toBe(Infinity)
    expect(Number.isNaN(pow2(NaN))).toBe(true)
  })
  it('powGlibc handles exact and special inputs', () => {
    expect(powGlibc(2, 10)).toBe(1024)
    expect(powGlibc(10, 5)).toBe(100000)
    expect(powGlibc(1, 7.5)).toBe(1)
    expect(powGlibc(0, 2)).toBe(0)
  })
  it('fma is a single-rounding a*b+c', () => {
    expect(fma(0.1, 10, -1)).toBe(5.551115123125783e-17)
    expect(fmaExact(0.1, 10, -1)).toBe(5.551115123125783e-17)
    expect(0.1 * 10 - 1).toBe(0)
    expect(fma(2, 3, 4)).toBe(10)
  })
})

describe('dataset', () => {
  const ds = makeDataset({
    n: 4,
    cluster_id: [3, 5, 7, 9],
    surface: [10, 20, 30, 40],
    roundness: [1, 1, 1, 1],
    short_axis: [1, 2, 3, 4],
    long_axis: [2, 3, 4, 5],
    volume: [1, 2, 3, 4],
    xmean: [1, 2, 3, 4],
    ymean: [4, 3, 2, 1],
    px_start: [0, 2, 3, 3],
    px_len: [2, 1, 0, 1],
    px_row: [1, 1, 2, 9],
    px_col: [1, 2, 3, 4],
  }, { pixel_scale: 12, label: 'x', meta: { a: 1 } })
  it('makeDataset defaults edge_weight to 1 and keeps typed columns', () => {
    expect(Array.from(ds.edge_weight)).toEqual([1, 1, 1, 1])
    expect(ds.surface).toBeInstanceOf(Float64Array)
    expect(ds.cluster_id).toBeInstanceOf(Int32Array)
    expect(ds.pixel_scale).toBe(12)
    expect(ds.label).toBe('x')
  })
  it('selectDataset copies scalars, shares pixel backing arrays, honours overrides', () => {
    const sel = selectDataset(ds, [1, 3], { label: 'sel' })
    expect(sel.n).toBe(2)
    expect(Array.from(sel.cluster_id)).toEqual([5, 9])
    expect(Array.from(sel.surface)).toEqual([20, 40])
    expect(sel.px_row).toBe(ds.px_row)
    expect(Array.from(sel.px_start)).toEqual([2, 3])
    expect(sel.label).toBe('sel')
    expect(sel.pixel_scale).toBe(12)
    expect(sel.meta).toBe(ds.meta)
    sel.surface[0] = -1
    expect(ds.surface[1]).toBe(20)
  })
  it('filterDatasetByClusterIds drops by cluster_id (not position)', () => {
    const f = filterDatasetByClusterIds(ds, new Set([5, 9, 100]))
    expect(Array.from(f.cluster_id)).toEqual([3, 7])
    expect(filterDatasetByClusterIds(ds, []).n).toBe(4)
  })
  it('dropPixels zeroes pixel info but keeps scalars', () => {
    const d = dropPixels(ds)
    expect(Array.from(d.px_len)).toEqual([0, 0, 0, 0])
    expect(d.px_row.length).toBe(0)
    expect(Array.from(d.surface)).toEqual([10, 20, 30, 40])
    expect(ds.px_len[0]).toBe(2)
  })
})

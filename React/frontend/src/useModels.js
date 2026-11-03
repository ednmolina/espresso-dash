import { useMemo, useSyncExternalStore } from 'react'
import { getExcludedShotIds, getRuns, subscribe } from './calibrationStore'
import { buildCalibration, settingToSize, sizeToSetting } from './grindCalibration'
import { buildForecastModel } from './forecastModel'

export function useCalibrationRuns() {
  const runs = useSyncExternalStore(subscribe, getRuns, getRuns)
  const excludedShotIds = useSyncExternalStore(subscribe, getExcludedShotIds, getExcludedShotIds)
  return { runs, excludedShotIds }
}

export function useGrindCalibration(shots) {
  const { runs, excludedShotIds } = useCalibrationRuns()
  const cal = useMemo(
    () => buildCalibration(shots || [], runs, excludedShotIds),
    [shots, runs, excludedShotIds],
  )
  return useMemo(() => ({
    points: cal.points,
    mean: cal.mean,
    dv50: cal.dv50,
    runs,
    excludedShotIds,
    estimate: (setting, metric = 'mean') => settingToSize(metric === 'dv50' ? cal.dv50 : cal.mean, setting),
    toSetting: (um, metric = 'mean') => sizeToSetting(metric === 'dv50' ? cal.dv50 : cal.mean, um),
  }), [cal, runs, excludedShotIds])
}

export function useForecastModel(shots, calibrationModel) {
  return useMemo(
    () => buildForecastModel(shots || [], { calibration: calibrationModel ? { mean: calibrationModel } : null }),
    [shots, calibrationModel],
  )
}

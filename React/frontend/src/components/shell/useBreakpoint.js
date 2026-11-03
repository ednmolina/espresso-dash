import { useSyncExternalStore } from 'react'

const PHONE = '(max-width: 640px)'
const TABLET = '(max-width: 1024px)'

function read() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'desktop'
  if (window.matchMedia(PHONE).matches) return 'phone'
  if (window.matchMedia(TABLET).matches) return 'tablet'
  return 'desktop'
}

function subscribe(listener) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const lists = [window.matchMedia(PHONE), window.matchMedia(TABLET)]
  lists.forEach((list) => list.addEventListener?.('change', listener))
  return () => lists.forEach((list) => list.removeEventListener?.('change', listener))
}

/** -> 'desktop' | 'tablet' | 'phone'. iPad at 1024 counts as tablet. */
export default function useBreakpoint() {
  return useSyncExternalStore(subscribe, read, () => 'desktop')
}

export { useBreakpoint }

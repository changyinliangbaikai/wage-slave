import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Detect clicks outside a referenced element.
 * The listener is only active when `active` is true.
 */
export function useClickOutside<T extends HTMLElement>(
  active: boolean,
  onOutside: () => void,
): RefObject<T> {
  const ref = useRef<T>(null) as RefObject<T>

  useEffect(() => {
    if (!active) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [active, onOutside])

  return ref
}

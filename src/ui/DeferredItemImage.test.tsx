import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DeferredItemImage } from './DeferredItemImage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('does not fetch offscreen images and loads a visible card once', async () => {
  let notify: IntersectionObserverCallback = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notify = callback }
    observe() {}
    disconnect = disconnect
  })
  const load = vi.fn().mockResolvedValue(undefined)
  render(<DeferredItemImage itemId="rack" onLoad={load} />)
  expect(load).not.toHaveBeenCalled()
  act(() => notify([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver))
  expect(load).not.toHaveBeenCalled()
  act(() => notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver))
  await waitFor(() => expect(load).toHaveBeenCalledExactlyOnceWith('rack'))
  expect(disconnect).toHaveBeenCalled()
})
it('loads a detail image immediately and allows retry after failure', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined)
  render(<DeferredItemImage itemId="rack" onLoad={load} eager />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
  fireEvent.click(screen.getByRole('button', { name: 'Retry image' }))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
})

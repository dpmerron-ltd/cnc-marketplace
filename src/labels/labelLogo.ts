import logoUrl from '../assets/888-van-racking-logo.png?inline'

// Bundle the logo with the renderer so saved/open tabs can print without a network fetch.
let logoPromise: Promise<HTMLImageElement> | undefined
export function loadLogo() {
  return logoPromise ??= new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => {
      logoPromise = undefined
      reject(new Error('Could not load the label logo. Please try again.'))
    }
    image.src = logoUrl
  })
}


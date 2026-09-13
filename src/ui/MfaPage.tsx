import { useState } from 'react'
import type { FormEvent } from 'react'

export interface MfaEnrollment {
  factorId: string
  qrCode: string
  secret: string
}

interface MfaPageProps {
  mode: 'enroll' | 'challenge'
  enrollment?: MfaEnrollment
  error?: string
  busy?: boolean
  onStartEnrollment: () => Promise<void>
  onVerify: (code: string) => Promise<void>
  onSignOut: () => void
}

function decodeQrCode(qrCode: string): string {
  if (qrCode.trim().startsWith('%3C')) return decodeURIComponent(qrCode)
  return qrCode
}

function qrCodeSrc(qrCode: string): string | undefined {
  const decoded = decodeQrCode(qrCode)
  if (decoded.startsWith('data:image')) return decoded
  if (decoded.trim().startsWith('<svg')) return undefined
  return `data:image/svg+xml;utf-8,${encodeURIComponent(decoded)}`
}

function QrCode({ qrCode }: { qrCode: string }) {
  const decoded = decodeQrCode(qrCode)
  const src = qrCodeSrc(qrCode)
  if (src) return <img className="mfa-qr" src={src} alt="Microsoft Authenticator QR code" />
  return <div className="mfa-qr mfa-qr-svg" aria-label="Microsoft Authenticator QR code" dangerouslySetInnerHTML={{ __html: decoded }} />
}

export function MfaPage({ mode, enrollment, error, busy = false, onStartEnrollment, onVerify, onSignOut }: MfaPageProps) {
  const [code, setCode] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await onVerify(code.trim())
  }

  return (
    <main className="login-shell">
      <section className="login-panel mfa-panel">
        <h1>Two-factor authentication</h1>
        {mode === 'enroll' ? (
          <>
            <p className="muted">Scan this code with Microsoft Authenticator, then enter the 6-digit code to finish setup.</p>
            {!enrollment ? (
              <button type="button" className="primary" disabled={busy} onClick={() => void onStartEnrollment()}>
                {busy ? 'Creating QR code...' : 'Set Up Authenticator'}
              </button>
            ) : (
              <>
                <QrCode qrCode={enrollment.qrCode} />
                <label>
                  Manual secret
                  <input value={enrollment.secret} readOnly />
                </label>
              </>
            )}
          </>
        ) : (
          <p className="muted">Enter the 6-digit code from Microsoft Authenticator.</p>
        )}

        {(mode === 'challenge' || enrollment) && (
          <form className="mfa-code-form" onSubmit={(event) => void submit(event)}>
            <label>
              Authenticator code
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="primary" disabled={busy || code.length !== 6}>
              {busy ? 'Verifying...' : 'Verify'}
            </button>
          </form>
        )}

        {error && mode === 'enroll' && !enrollment && <p className="login-error">{error}</p>}
        <button type="button" onClick={onSignOut}>Sign Out</button>
      </section>
    </main>
  )
}

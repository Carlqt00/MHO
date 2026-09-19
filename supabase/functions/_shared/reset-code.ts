// Password-reset code hashing shared by password-reset-request (writes) and
// password-reset-complete (verifies).
//
// The code is only 6 digits, so it is hashed together with the request id:
// a leaked table row cannot be brute-forced offline without also knowing the
// id, and one code can never be replayed against another request.
export const RESET_CODE_LENGTH = 6
export const RESET_CODE_MAX_ATTEMPTS = 5

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function hashResetCode(requestId: string, code: string): Promise<string> {
  return sha256Hex(`${requestId}:${code}`)
}

export function isResetCode(value: string): boolean {
  return new RegExp(`^\d{${RESET_CODE_LENGTH}}$`).test(value)
}

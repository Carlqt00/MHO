export function normalizePhilippineMobileSubscriber(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('63')) digits = digits.slice(2)
  else if (digits.startsWith('0')) digits = digits.slice(1)
  return digits.slice(0, 10)
}

export function isValidPhilippineMobileSubscriber(digits: string): boolean {
  return /^9\d{9}$/.test(digits)
}

export function toCanonicalPhilippineMobile(raw: string): string | null {
  const subscriber = normalizePhilippineMobileSubscriber(raw)
  return isValidPhilippineMobileSubscriber(subscriber) ? `+63${subscriber}` : null
}

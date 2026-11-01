let counter = 0
/** Unique-enough id that works in insecure (plain HTTP) contexts where crypto.randomUUID is missing. */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 0x7fffffff
  const rnd = Math.floor(Math.random() * 0xffffffff).toString(36)
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rnd}`
}

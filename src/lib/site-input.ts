import { z } from "zod"

// What the Add site form accepts. Shared by the form (to show errors as you
// type) and the server action (which re-checks everything).

const optional = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === "" ? null : v))

export const SiteInput = z.object({
  code: z.string().trim().toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, "ใช้ A-Z, 0-9 และ - ได้ 2–20 ตัว เช่น BKK-BR04"),
  name: z.string().trim().min(1, "กรุณาระบุชื่อ Site").max(100),
  customer: z.string().trim().min(1, "กรุณาระบุลูกค้า").max(100),
  region: z.string().trim().min(1, "กรุณาระบุภูมิภาค").max(50),
  status: z.enum(["ONLINE", "DEGRADED", "OFFLINE"]),
  address: optional(200),
  contact: optional(100),
  phone: optional(50),
  note: optional(500),
})

export type SiteInputRaw = z.input<typeof SiteInput>
export type SiteFieldErrors = Partial<Record<keyof SiteInputRaw, string>>

export function fieldErrors(error: z.ZodError): SiteFieldErrors {
  const out: SiteFieldErrors = {}
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof SiteInputRaw
    out[key] ??= issue.message
  }
  return out
}

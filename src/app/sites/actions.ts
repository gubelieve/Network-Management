"use server"

import { revalidatePath } from "next/cache"
import { SITES } from "@/lib/sample-data"
import { fieldErrors, SiteInput, type SiteFieldErrors, type SiteInputRaw } from "@/lib/site-input"
import { appendSite } from "@/lib/site-store"

// No login exists yet (see README): when auth arrives, check it here first —
// a Server Action is reachable by a direct POST, not only from the form.

export type AddSiteResult =
  | { ok: true; code: string }
  | { ok: false; error: string; fields?: SiteFieldErrors }

class DuplicateCode extends Error {}

export async function addSite(raw: SiteInputRaw): Promise<AddSiteResult> {
  const parsed = SiteInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: "กรุณาตรวจสอบข้อมูลที่กรอก", fields: fieldErrors(parsed.error) }
  const input = parsed.data

  try {
    const site = await appendSite((stored) => {
      // Checked inside the write queue, against the sample sites and the
      // stored ones, so two people cannot both add the same code.
      const all = [...SITES, ...stored]
      if (all.some((s) => s.code.toLowerCase() === input.code.toLowerCase())) throw new DuplicateCode()
      return { id: Math.max(0, ...all.map((s) => s.id)) + 1, ...input }
    })
    revalidatePath("/", "layout")
    return { ok: true, code: site.code }
  } catch (e) {
    if (e instanceof DuplicateCode) return { ok: false, error: "รหัส Site นี้มีอยู่แล้ว", fields: { code: "รหัส Site นี้มีอยู่แล้ว" } }
    throw e
  }
}

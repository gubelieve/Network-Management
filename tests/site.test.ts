import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { addSite } from "@/app/sites/actions"
import { DATA_DIR } from "@/lib/config-store"
import { findSite, getSite, listSites } from "@/lib/data"
import { SiteInput } from "@/lib/site-input"

// revalidatePath needs a Next request context; outside one it is a no-op we can stub.
import { vi } from "vitest"
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }))

const base = { name: "Test Branch", customer: "Customer T", region: "Bangkok", status: "ONLINE" as const, address: "", contact: "", phone: "", note: "" }

describe("SiteInput", () => {
  it("upper-cases the code and turns empty optional fields into null", () => {
    const r = SiteInput.parse({ ...base, code: " bkk-br09 " })
    expect(r.code).toBe("BKK-BR09")
    expect(r.address).toBeNull()
  })

  it("rejects codes that would not be safe in a URL", () => {
    expect(SiteInput.safeParse({ ...base, code: "BKK BR" }).success).toBe(false)
    expect(SiteInput.safeParse({ ...base, code: "-X" }).success).toBe(false)
  })
})

describe("addSite", () => {
  it("adds a site that then appears everywhere sites are listed", async () => {
    const res = await addSite({ ...base, code: "tst-01" })
    expect(res).toEqual({ ok: true, code: "TST-01" })
    expect((await listSites()).map((s) => s.code)).toContain("TST-01")
    const site = await getSite("tst-01")
    expect(site).toMatchObject({ name: "Test Branch", devices: [], subnets: [] })
    expect(site!.id).toBeGreaterThan(6)
  })

  it("refuses a code that is already taken, by a sample site or an added one", async () => {
    expect(await addSite({ ...base, code: "BKK-HQ" })).toMatchObject({ ok: false, fields: { code: expect.any(String) } })
    expect(await addSite({ ...base, code: "TST-01" })).toMatchObject({ ok: false })
  })

  it("does not lose a site when two are added at once", async () => {
    await Promise.all([addSite({ ...base, code: "TST-02" }), addSite({ ...base, code: "TST-03" })])
    expect(await findSite("TST-02")).not.toBeNull()
    expect(await findSite("TST-03")).not.toBeNull()
  })

  it("returns field errors for missing required fields", async () => {
    const res = await addSite({ ...base, code: "TST-04", name: "" })
    expect(res).toMatchObject({ ok: false, fields: { name: expect.any(String) } })
  })
})

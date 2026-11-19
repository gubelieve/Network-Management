"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Save } from "lucide-react"
import { Button } from "@astryxdesign/core/Button"
import { Selector } from "@astryxdesign/core/Selector"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { Panel } from "@/components/page-header"
import type { SiteFieldErrors, SiteInputRaw } from "@/lib/site-input"
import { SITE_STATUS } from "@/lib/status"
import { addSite } from "../actions"

const EMPTY: SiteInputRaw = { code: "", name: "", customer: "", region: "", status: "ONLINE", address: "", contact: "", phone: "", note: "" }

export function AddSiteForm({ customers, regions }: { customers: string[]; regions: string[] }) {
  const router = useRouter()
  const toast = useToast()
  const [v, setV] = React.useState<SiteInputRaw>(EMPTY)
  const [errors, setErrors] = React.useState<SiteFieldErrors>({})
  const set = (k: keyof SiteInputRaw) => (value: string) => {
    setV((prev) => ({ ...prev, [k]: k === "code" ? value.toUpperCase() : value }))
    setErrors((prev) => ({ ...prev, [k]: undefined }))
  }
  const status = (k: keyof SiteInputRaw) => (errors[k] ? { type: "error" as const, message: errors[k] } : undefined)

  const submit = async () => {
    const res = await addSite(v)
    if (!res.ok) {
      setErrors(res.fields ?? {})
      toast({ body: res.error, type: "error" })
      return
    }
    toast({ body: `เพิ่ม Site ${res.code} แล้ว` })
    router.push(`/sites/${res.code}`)
  }

  return (
    <Panel>
      <div className="grid max-w-3xl grid-cols-1 gap-4 md:grid-cols-2">
        <TextInput label="รหัส Site" isRequired value={v.code} onChange={set("code")} placeholder="เช่น BKK-BR04" status={status("code")}
          description="ใช้ใน URL และเมนู แก้ภายหลังไม่ได้" />
        <TextInput label="ชื่อ Site" isRequired value={v.name} onChange={set("name")} placeholder="เช่น Bangkok Branch 4" status={status("name")} />
        <div>
          <TextInput label="ลูกค้า" isRequired value={v.customer} onChange={set("customer")} status={status("customer")} />
          <Suggestions values={customers} onPick={set("customer")} />
        </div>
        <div>
          <TextInput label="ภูมิภาค" isRequired value={v.region} onChange={set("region")} status={status("region")} />
          <Suggestions values={regions} onPick={set("region")} />
        </div>
        <Selector label="สถานะ" value={v.status} onChange={(s) => setV((p) => ({ ...p, status: s as SiteInputRaw["status"] }))}
          options={(Object.keys(SITE_STATUS) as (keyof typeof SITE_STATUS)[]).map((k) => ({ value: k, label: SITE_STATUS[k].label }))} />
        <TextInput label="ที่อยู่" isOptional value={v.address ?? ""} onChange={set("address")} status={status("address")} />
        <TextInput label="ผู้ติดต่อ" isOptional value={v.contact ?? ""} onChange={set("contact")} status={status("contact")} />
        <TextInput label="โทรศัพท์" isOptional value={v.phone ?? ""} onChange={set("phone")} status={status("phone")} />
        <div className="md:col-span-2">
          <TextArea label="หมายเหตุ" isOptional value={v.note ?? ""} onChange={set("note")} rows={3} status={status("note")} />
        </div>
      </div>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" label="Save site" icon={<Save className="h-3.5 w-3.5" />} clickAction={submit} />
        <Button variant="secondary" label="Cancel" href="/sites" />
      </div>
    </Panel>
  )
}

/** Existing values as one-click fills, so "Customer A" is not typed three different ways. */
function Suggestions({ values, onPick }: { values: string[]; onPick: (v: string) => void }) {
  if (!values.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {values.map((x) => (
        <button key={x} type="button" onClick={() => onPick(x)} className="bg-muted rounded-full px-2 py-0.5 text-xs hover:opacity-80">{x}</button>
      ))}
    </div>
  )
}

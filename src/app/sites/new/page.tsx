import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { allSites } from "@/lib/data"
import { AddSiteForm } from "./add-site-form"

export default async function NewSitePage() {
  const sites = await allSites()
  return (
    <>
      <div className="text-muted-foreground mb-1 text-xs"><Link href="/sites" className="hover:underline">All sites</Link> / Add site</div>
      <PageHeader title="Add site" description="เพิ่ม Site ใหม่ที่ต้องดูแล หลังบันทึกแล้วไปที่ Import configuration เพื่อเพิ่มอุปกรณ์ของ Site จาก running-config ได้" />
      <AddSiteForm
        customers={[...new Set(sites.map((s) => s.customer))].sort()}
        regions={[...new Set(sites.map((s) => s.region))].sort()}
      />
    </>
  )
}

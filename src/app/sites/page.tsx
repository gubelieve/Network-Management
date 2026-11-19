import { Plus } from "lucide-react"
import { Button } from "@astryxdesign/core/Button"
import { PageHeader, Panel } from "@/components/page-header"
import { listSites } from "@/lib/data"
import { SitesTable } from "./sites-table"

export default async function SitesPage() {
  const sites = await listSites()
  return (
    <>
      <PageHeader
        title="All sites"
        description="รายชื่อ Site ทั้งหมดที่ดูแล ค้นหาด้วยรหัส ชื่อ ลูกค้า หรือภูมิภาค แล้วคลิกเพื่อดูอุปกรณ์ Subnet และวงจร WAN ของ Site นั้น"
        actions={<Button variant="primary" label="Add site" icon={<Plus className="h-3.5 w-3.5" />} href="/sites/new" />}
      />
      <Panel>
        <SitesTable sites={sites} />
      </Panel>
    </>
  )
}

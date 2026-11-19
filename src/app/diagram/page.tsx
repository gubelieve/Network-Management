import { PageHeader } from "@/components/page-header"
import { findSite, getSiteTopology, listSites } from "@/lib/data"
import { DiagramClient } from "./diagram-client"

export default async function DiagramPage({ searchParams }: { searchParams: Promise<{ site?: string; endpoints?: string }> }) {
  const { site: wanted, endpoints } = await searchParams
  const includeEndpoints = endpoints === "1"
  const sites = await listSites()
  // Default to the first site that has imports, so the page opens on something to look at.
  const site = (wanted && (await findSite(wanted))) || sites.find((s) => s.configCount > 0) || sites[0]
  const data = await getSiteTopology(site.code, { includeEndpoints })

  return (
    <>
      <PageHeader
        title="Diagram"
        description="Network diagram ของ Site จากผลคำสั่งที่ Import มา: เส้นเชื่อมยืนยันจาก show cdp neighbors และ show ip ospf neighbor, จับคู่ IP วง /30–/31 จาก show run, รวม member เป็น Port-channel จาก show port-channel summary, ตัดพอร์ตที่ down ตาม show interfaces status/description, แสดง VLAN จาก show interfaces trunk และวาด WAN จาก default route ใน show ip route ลากอุปกรณ์เพื่อจัดตำแหน่ง ใช้ล้อเมาส์เพื่อซูม"
      />
      <DiagramClient
        key={`${site.code}-${includeEndpoints}`}
        sites={sites.map((s) => ({ code: s.code, name: s.name, configCount: s.configCount }))}
        siteCode={site.code}
        topology={data!.topology}
        configCount={data!.configCount}
        includeEndpoints={includeEndpoints}
      />
    </>
  )
}

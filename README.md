# Network Site Manager

เว็บสำหรับดูแล Network ของแต่ละ Site: สถานะ Site, อุปกรณ์ (Router / Switch / Firewall / WLC / AP), Subnet / VLAN และวงจร WAN

ใช้ environment เดียวกับ **Lab_management (AIT QuickLab)**: Next.js 16, React 19, Tailwind 4, Astryx design system, Prisma 7 + PostgreSQL (pg adapter), Docker + nginx

> **สถานะตอนนี้:** หน้าเว็บอ่านข้อมูลตัวอย่างจาก `src/lib/sample-data.ts` (ข้อมูลสมมติทั้งหมด) ยังไม่ได้ต่อฐานข้อมูลและยังไม่มีระบบ login

## หน้าเว็บ

| Route | เนื้อหา |
|---|---|
| `/` | Dashboard: จำนวน Site/อุปกรณ์, การ์ดสถานะแต่ละ Site, อุปกรณ์ที่ Down / Warning |
| `/sites` | รายชื่อ Site ทั้งหมด ค้นหาและกรองตามสถานะได้ |
| `/sites/[code]` | รายละเอียด Site: ข้อมูลติดต่อ, Health, อุปกรณ์, Subnet / VLAN, วงจร WAN |
| `/devices` | อุปกรณ์ทุกตัวจากทุก Site |
| `/import` | **Import configuration**: อัปโหลดผลคำสั่ง show ของอุปกรณ์ เพื่ออัปเดตข้อมูลอุปกรณ์และ Subnet/VLAN ของ Site |
| `/diagram` | **Diagram**: วาด topology ของ Site จากผลคำสั่งที่ Import มา |
| `/sites/new` | **Add site**: เพิ่ม Site ใหม่ (ปุ่ม Add site ในหน้า All sites) |

## Import configuration

ไฟล์ละ 1 อุปกรณ์ เป็น log ที่มีผลของคำสั่งเหล่านี้ จะมีครบหรือไม่ก็ได้ แต่ยิ่งครบ Diagram ยิ่งแม่น:

| คำสั่ง | ใช้ทำอะไร |
|---|---|
| `show running-config` | hostname, version, interface, IP, VLAN, channel-group |
| `show cdp neighbors` (หรือ `detail`) | link ที่แน่นอนทั้งสองฝั่ง และอุปกรณ์เพื่อนบ้านที่ยังไม่ได้ Import |
| `show interfaces status` | สถานะพอร์ต: พอร์ตที่ notconnect / disabled จะไม่ถูกวาดเป็น link |
| `show interfaces description` | description และสถานะ up/down ของพอร์ต |
| `show interfaces trunk` | VLAN ที่วิ่งบนแต่ละ link |
| `show port-channel summary` / `show etherchannel summary` | รวม member link เป็น Port-channel เดียว |
| `show ip route` | default gateway (WAN) และ connected subnet |
| `show ip ospf neighbor` | link ระหว่าง router/L3 switch จาก IP ของเพื่อนบ้าน |

- ระบบหาแต่ละคำสั่งจากบรรทัด prompt เช่น `HQ-CORE-01#show cdp nei` (พิมพ์ย่อได้) หรือบรรทัดที่ขึ้นต้นด้วย `show ...` ถ้าในไฟล์ไม่มีคำสั่งเลย จะถือว่าทั้งไฟล์เป็น running-config
- hostname มาจากบรรทัด `hostname` ใน running-config หรือจาก prompt ถ้าไม่มี running-config
- รองรับรูปแบบของ Cisco IOS / IOS-XE และ NX-OS (running-config รองรับ Aruba AOS-CX ด้วย)
- ก่อนบันทึกจะแสดงให้ตรวจว่าแต่ละไฟล์มีคำสั่งไหนบ้าง จำนวน interface / CDP / OSPF / route และ Mgmt IP
- ผลที่ได้: อุปกรณ์ hostname เดียวกันจะได้ OS version และ Mgmt IP (interface ที่ชื่อหรือ description เป็น mgmt → Loopback0 → SVI แรก → IP แรก), hostname ใหม่กลายเป็นอุปกรณ์ใหม่, interface ที่มี IP และ connected route จะเพิ่ม Subnet ที่ Site ยังไม่มี
- ไฟล์เก็บใน `data/configs/<SITE>/<hostname>.json` (อยู่ใน .gitignore) เก็บแค่ข้อความดิบและอ่านใหม่ทุกครั้ง ตัวอ่านที่ปรับปรุงภายหลังจึงมีผลกับไฟล์เก่าด้วย
- ไฟล์ตัวอย่าง (ข้อมูลสมมติ) อยู่ใน `samples/configs/BKK-HQ/`

## Diagram

เส้นเชื่อมสร้างจากหลักฐานหลายแบบ เรียงจากแน่นอนที่สุด แต่ละเส้นจำไว้ว่ามาจากหลักฐานไหน (ชี้เมาส์ที่เส้นเพื่อดู):

1. **CDP**: ทั้งสองฝั่งตรงตามที่อุปกรณ์รายงาน
2. **OSPF neighbor**: จับคู่ IP ของเพื่อนบ้านกับอุปกรณ์ที่เป็นเจ้าของ IP นั้น ถ้า adjacency วิ่งบน SVI/loopback จะใช้เป็นหลักฐานเสริมของเส้นที่มีอยู่ ไม่วาดเส้นใหม่
3. **IP วง /30–/31 เดียวกัน**: จาก running-config
4. **Interface description** ระบุชื่ออุปกรณ์ปลายทาง: ใช้เฉพาะพอร์ตที่ข้อ 1–3 ยังอธิบายไม่ได้
5. **Default route**: next hop ที่เป็นอุปกรณ์ใน Site จะเชื่อมกัน ส่วน next hop ที่ไม่ใช่อุปกรณ์ใน Site จะวาดเป็นกล่อง WAN / ISP

นอกจากนี้:
- Member ของ Port-channel รวมเป็นเส้นเดียว (เส้นหนา, ชี้เพื่อดู member)
- พอร์ตที่ shutdown, notconnect, disabled หรือ down ไม่ถูกวาดเป็น link
- Subnet วงใหญ่กว่า /30 ที่อุปกรณ์ตั้งแต่ 2 ตัวขึ้นไปใช้ร่วมกัน แสดงเป็น LAN segment (VLAN)
- อุปกรณ์ที่พบจาก CDP, description หรือ OSPF แต่ยังไม่ได้ Import แสดงเป็นกรอบเส้นประ IP Phone และ endpoint จาก CDP ซ่อนไว้ เปิดได้ด้วยตัวเลือก "แสดง IP Phone / endpoint"
- เส้นทึบ = ยืนยันจาก CDP, OSPF หรือ IP · เส้นประ = อนุมานจาก description หรือ route

การใช้งาน: ลากอุปกรณ์เพื่อจัดตำแหน่ง (ตำแหน่งจะถูกจำไว้ใน browser นั้น), ลากพื้นหลังเพื่อเลื่อน, ใช้ล้อเมาส์เพื่อซูม, คลิกอุปกรณ์เพื่อดูตาราง interface / CDP / OSPF / route และกด Download SVG เพื่อบันทึกภาพ

> ยังไม่มีระบบ login ทุกคนที่เข้าเว็บได้จะเพิ่ม Site, Import และลบ config ได้ ต้องเพิ่ม auth ก่อนเปิดให้ใช้งานจริง

## รันบนเครื่อง

```powershell
cd Network_Site_Manager
npm install
npm run dev
```

เปิด http://localhost:8020

## ต่อฐานข้อมูล (ขั้นต่อไป)

1. คัดลอก `.env.example` เป็น `.env` แล้วใส่ `DATABASE_URL` (Postgres, ระบุ `?schema=`)
2. `npm run db:push` เพื่อสร้างตารางตาม `prisma/schema.prisma`
3. เปลี่ยนเนื้อฟังก์ชันใน `src/lib/data.ts` ให้ query ผ่าน `src/lib/prisma.ts` โดย signature ของฟังก์ชันเหมือนเดิม หน้าเว็บจึงไม่ต้องแก้

## Deploy

```powershell
docker compose --env-file .env.production up -d --build
```

nginx เปิดที่พอร์ต 8020 และ app ไม่ถูก publish ออกมาตรง ๆ (รูปแบบเดียวกับ Lab_management) ถ้าจะ publish ใต้ path ย่อย ให้ตั้ง `NEXT_PUBLIC_BASE_PATH` ตอน build

## ตรวจสอบ

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

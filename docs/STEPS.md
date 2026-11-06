# แผนงาน Capstone: Step 2–6

| Step | Area | เรื่อง | เวลา |
|---|---|---|---|
| [Step 2](#step-2-area-a--แยก-service-และตั้ง-gateway-16-ชม) | A | แยก service และตั้ง gateway | 16 ชม. |
| [Step 3](#step-3-area-b--security-12-ชม) | B | Security | 12 ชม. |
| [Step 4](#step-4-area-c--outbox-rabbitmq-และ-saga-20-ชม) | C | Outbox, RabbitMQ และ saga | 20 ชม. |
| [Step 5](#step-5-area-d--resilience-12-ชม) | D | Resilience | 12 ชม. |
| [Step 6](#step-6-area-e--observability-และ-pact-12-ชม) | E | Observability และ Pact | 12 ชม. |

> หมายเหตุ: ไฟล์นี้ไม่มี Step 1 (Step 5 อ้างถึง "คำถามใน Step 1")

---

## Step 2: Area A — แยก service และตั้ง gateway (16 ชม.)

### 2.1 Notifications service

Express + Postgres ของตัวเอง

- ย้ายตาราง `notifications` ไปไว้ใน service นี้
- `app/notifications/page.js` เปลี่ยนไปเรียก HTTP โดยส่ง cookie token ต่อเป็น Bearer และใส่ `cache: 'no-store'`
- `providers/service.js:96` เปลี่ยนเป็นเขียนอีเวนต์ `provider.approved` ลงตาราง `events` แทนการ insert ตรง
- ไม่ต้องแก้ `app/layout.js` เพราะมีแค่ลิงก์

### 2.2 Payments & Wallet service

Express + Postgres ของตัวเอง

**ย้าย 4 ตาราง:**
- `payment_intents` (เพิ่มคอลัมน์ `customer_id`)
- `transactions`
- `provider_wallets`
- `webhook_events`

**สิ่งที่ต้องแก้ใน monolith:**

| จุดที่แก้ | เปลี่ยนเป็น |
|---|---|
| `placeBooking` | เรียก `POST /intents` แบบ sync โดยใช้ `Idempotency-Key = order_id` แล้วเก็บ `gateway_ref` และ `payment_status` ไว้บน order |
| `getBooking` (`booking/service.js:354`) | อ่านสำเนาที่เก็บบน order แทนการอ่านตารางของ Payments |
| `completeBooking` | เก็บ UPDATE เดิมที่มี `WHERE otp=?` ไว้ ส่วนการเครดิต wallet เปลี่ยนเป็นอีเวนต์ `booking.completed` (ระหว่าง Step 2 ส่งผ่าน events table ไปก่อน แล้ว Step 4 จึงเปลี่ยนไปใช้ RabbitMQ) |
| `cancelBooking` | ส่งอีเวนต์ `booking.cancelled` แล้ว Payments ทำ refund เอง |
| webhook | ปล่อยอีเวนต์ `payment.succeeded` แล้วให้ Booking เป็นฝ่ายเรียก `markPaid` เอง |
| `insertProviderWallet` (`identity/repository.js:36`) | ลบออก และให้ Payments upsert wallet ตอนเครดิตครั้งแรก |
| `provider/wallet/page.js` และ `provider/dashboard/page.js` | เปลี่ยนไปเรียก HTTP |
| seed | Payments ใส่ wallet ของ provider ID ชุดเดียวกับ monolith |

### 2.3 Gateway (nginx)

| location | ส่งไป |
|---|---|
| `= /api/notifications` | Notifications service |
| `^~ /api/notifications/` | Notifications service |
| `^~ /api/payments/` | Payments service |
| `= /api/provider/wallet` | Payments service |
| `= /api/customer/transactions` | Payments service |
| path อื่นทั้งหมด | monolith |

- ส่ง `X-Request-Id` และ `traceparent` ต่อไปด้วย

### ✅ ถือว่าเสร็จเมื่อ

- [ ] `grep -rE "payment_intents|transactions|provider_wallets|webhook_events|notifications" lib/modules` ไม่เจอเลยสักจุด และตารางเหล่านี้ถูกลบออกจาก schema ของ monolith แล้ว
- [ ] booking แรกหลังบูตยังได้ id `8001`
- [ ] หน้า UI ทุกหน้าทำงานที่ URL เดิม
- [ ] เทสต์ทั้งของ monolith และของ service ผ่าน

---

## Step 3: Area B — Security (12 ชม.)

### 3.1 Keycloak realm

- นำเข้าผู้ใช้ seed 7 คน ใช้รหัสผ่าน `eDemand-2026!` เหมือนเดิม
- client `web` (ใช้ล็อกอิน)
- audience `payments-api` และ `notifications-api`
- mapper สำหรับ `app_id` และ `role`

### 3.2 ทุก service ตรวจ token เอง

- ตรวจลายเซ็นผ่าน JWKS, ตรวจ `iss`, `aud` และ `exp` (ใช้ `jose` ใน Express)
- ถ้าผิดตอบ `401`

### 3.3 ตรวจความเป็นเจ้าของ

- provider ดูได้เฉพาะ wallet ของตัวเอง
- simulate ได้เฉพาะ intent ที่ `customer_id` ตรงกับผู้เรียก
- mark read ได้เฉพาะ notification ของตัวเอง

### 3.4 Monolith

- เปลี่ยนจากการตรวจ HS256 ไปตรวจ token จาก Keycloak (เลิกใช้ HS256 ไปเลย ไม่ต้องรองรับสองแบบพร้อมกัน)

### 3.5 BOLA

ตัวเลือกคือ `GET /api/jobs/:id` (`bidding/service.js:76`) ที่ลูกค้าคนหนึ่งอาจอ่าน job ของลูกค้าอีกคนได้

ขั้นตอน:
1. เขียนเทสต์โจมตีให้เห็นว่ารั่วก่อน
2. แก้
3. รันเทสต์เดิมให้เห็นว่าตอบ `403`

ถ้าทีมสรุปว่าพฤติกรรมนี้ตั้งใจให้เป็นแบบนั้น ให้รายงานตามจริง

### ✅ ถือว่าเสร็จเมื่อ

- [ ] token ปลอม, หมดอายุ และ audience ผิด ตอบ `401` ครบทั้งสาม กับทั้งสอง service โดยมีเทสต์และ curl เป็นหลักฐาน

---

## Step 4: Area C — Outbox, RabbitMQ และ saga (20 ชม.)

### 4.1 Outbox และ relay

- monolith ใช้ตาราง `events` เดิม ส่วนทั้งสอง service มีตาราง outbox ของตัวเอง
- Relay ใหม่: publish (เปิด publisher confirms) ก่อน แล้วค่อย mark ว่าส่งแล้ว ซึ่งต่างจากของเดิมที่ claim ก่อน (at-most-once)
- ส่วนคำนวณ rating: ยังอยู่ใน monolith โดยเป็น consumer ของ `review.created`

### 4.2 Consumer ทุกตัว idempotent

- `INSERT` ลง `processed_messages(message_id PK)` ใน transaction เดียวกับผลของข้อความ
- มีเทสต์ส่งข้อความซ้ำแล้วต้องเกิดผลเพียงครั้งเดียว

### 4.3 อีเวนต์ข้าม service (อย่างน้อย 2 ตัว)

| อีเวนต์ | ไปที่ | ผล |
|---|---|---|
| `booking.completed` | Payments | เครดิต wallet |
| `payment.succeeded` | Booking | mark paid |
| อีเวนต์ที่เหลือ | Notifications | |

### 4.4 Saga แบบ orchestration (Booking เป็นผู้คุม)

| ขั้น | ทำอะไร | Compensation |
|---|---|---|
| 1 | สร้าง order และ `slot_holds` | cancel order และปล่อย slot |
| 2 | Payments `POST /intents` | ยกเลิก intent |
| 3 | `payment.succeeded` ทำให้ order เป็น paid | `booking.cancelled` ทำให้ Payments refund |
| timeout | ไม่จ่ายภายใน N นาที | cancel และปล่อย slot |

**กรณีที่ต้องรองรับ:** ถ้า `payment.succeeded` มาถึงหลัง order ถูก cancel แล้ว ให้ refund อัตโนมัติ

### 4.5 DLQ

- ข้อความที่ consumer ล้มเหลวเกิน 3 ครั้งให้ย้ายไปไว้ที่ dead-letter queue

---

## Step 5: Area D — Resilience (12 ชม.)

### 5.1 การเรียกที่ใส่ resilience

- `POST /intents`: timeout 2 วินาที และ retry 3 ครั้งแบบ exponential backoff กับ full jitter
- ฝั่ง Payments: ใช้ `Idempotency-Key` เป็น PK เมื่อได้ key ซ้ำให้คืนคำตอบเดิม

### 5.2 Fault switch 3 ตัว

สั่งงานผ่าน env หรือ admin endpoint

| # | Fault | ผลที่ต้องได้ |
|---|---|---|
| 1 | เขียนเสร็จแล้วแต่ตัดคำตอบทิ้ง → client retry | ต้องมี intent แค่ 1 แถว |
| 2 | ตอบช้ากว่า timeout → client retry | ต้องมี intent แค่ 1 แถว |
| 3 | service ล้มช่วงหนึ่ง → retry จนหมด | ใช้ saga compensation (cancel และปล่อย slot) ระบบไม่ค้าง |

### 5.3 Race: เครดิต wallet ซ้ำ

เกิดเมื่อ `booking.completed` ถูกส่งซ้ำพร้อมกัน

1. **commit แรก:** เขียน dedupe แบบ SELECT แล้วค่อย INSERT และมีเทสต์ยิงพร้อมกัน 10 ข้อความ ผลที่คาดคือเครดิตมากกว่า 1 ครั้ง
2. **commit ที่สอง:** แก้ไปใช้ PK ภายใน transaction แล้วเทสต์ต้องได้เครดิต 1 ครั้งพอดี

> ⚠️ ทำตามนี้ได้ต่อเมื่ออาจารย์อนุญาตตามคำถามใน Step 1
>
> **ตัวสำรอง:** cancel ชนกับการจ่ายเงิน (ดู [Step 4](#44-saga-แบบ-orchestration-booking-เป็นผู้คุม))

---

## Step 6: Area E — Observability และ Pact (12 ชม.)

### 6.1 OpenTelemetry

| ส่วน | วิธี |
|---|---|
| monolith | `@opentelemetry/sdk-node` ใน `instrumentation.js` (hook นี้เปิดอยู่แล้ว) |
| Express | auto-instrumentation และ `instrumentation-amqplib` ซึ่งส่ง context ผ่าน header ของ RabbitMQ |
| nginx | แค่ส่ง `traceparent` ต่อ ไม่ต้องสร้าง span |

### 6.2 Logs

- `pino` แบบ JSON โดยทุกบรรทัดมี `request_id` และ `trace_id`

### 6.3 Metrics และ dashboard

- Prometheus และ Grafana แสดง RED (rate, errors, duration) ของทั้ง 3 service
- provision dashboard JSON ไว้ใน repo

### 6.4 Trace ข้ามทั้งสองรอยต่อ

- **ทาง HTTP:** place booking → `/intents`
- **ทางอีเวนต์:** complete → wallet credit กับ notification

### 6.5 Pact

- สัญญา monolith → Payments และ monolith → Notifications
- มี workflow `.github/workflows/contracts.yml` และรันด้วย `act`
- ⚠️ ปิด stack ก่อนรัน `act`

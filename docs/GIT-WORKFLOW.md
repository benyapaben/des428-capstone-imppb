# Git Workflow ของทีม

เอกสารนี้คือข้อตกลงการใช้ Git ของทีม ทุกคนทำตามแบบเดียวกัน เพื่อให้ `main` ใช้งานได้ตลอดและ conflict น้อยที่สุด

---

## TL;DR

```
แตก branch จาก main ล่าสุด → ทำงาน + commit → rebase ตาม main → เทสต์ผ่าน → เปิด PR → เพื่อนรีวิว → Squash merge → ลบ branch
```

1. **ห้าม push ตรงเข้า `main`** ทุกอย่างต้องผ่าน Pull Request
2. **1 branch = 1 งาน** ทำเสร็จภายใน 1–3 วัน
3. **pull `main` ก่อนแตก branch** ทุกครั้ง
4. **เทสต์ต้องผ่านก่อน push**
5. **merge แล้วลบ branch** และไม่กลับไปใช้ branch เดิมอีก

---

## 1. ตั้งค่าครั้งแรก

```bash
git clone <repo-url>
cd des428-capstone-imppb

git config user.name  "ชื่อของคุณ"
git config user.email "อีเมลที่ใช้กับ GitHub"
```

โปรเจกต์นี้ต้องใช้ **Node 20** (ดูได้จากไฟล์ `.nvmrc`) เพราะถ้าใช้ Node 24 ขึ้นไป `npm install` จะพัง:

```bash
node -v          # ต้องเป็น v20.x
npm install
npm test         # เทสต์ monolith ต้องผ่านทั้งหมด (66 ตัว)
```

> ⚠️ **ถ้าใช้ Windows:** `npm test` จะ error ว่า `Could not find '...\test\*.test.js'` เพราะ `cmd.exe` ขยาย `*` ไม่ได้ ให้รัน `node --test test/*.test.js` จาก Git Bash แทน หรือจะใช้ Docker ก็ได้

ถ้าในเครื่องมี Node หลายเวอร์ชัน ให้ใช้ `nvm use` หรือ `fnm use` หรือจะรันผ่าน Docker แทนก็ได้:

```bash
docker compose up -d --build --wait                                  # ทั้งระบบ เปิดที่ http://localhost:8080 (ผ่าน gateway)
docker compose --profile test run --rm --build test                  # เทสต์ monolith
docker compose --profile test run --rm --build notifications-test    # เทสต์ Notifications service (ใช้ Postgres)
docker compose --profile test run --rm --build payments-test         # เทสต์ Payments service (ใช้ Postgres)
docker compose down -v                                               # ปิดทั้งหมด
```

ตั้งแต่ Step 2 ต้องเปิดเว็บที่ **:8080** (gateway) ส่วน `:3000` เป็น monolith ตรงๆ ใช้ debug เท่านั้น เพราะหน้า notifications และ wallet จะไม่ทำงานบนพอร์ตนี้

> ⚠️ ต้องใส่ `--build` ทุกครั้ง เพราะ Docker copy โค้ดเข้าไปตอน build image ถ้าไม่ใส่ จะได้โค้ดเวอร์ชันเก่าโดยไม่มีอะไรเตือน

### ถ้าใช้ Claude Code: สร้าง `CLAUDE.local.md`

ใน repo มีไฟล์ 2 ไฟล์ที่ Claude Code อ่านให้อัตโนมัติ:

| ไฟล์ | ใช้ทำอะไร | ขึ้น GitHub? |
|---|---|---|
| `CLAUDE.md` | กฎของโปรเจกต์ที่ทั้งทีมใช้ร่วมกัน เช่น architecture, เทสต์, Git workflow | ✅ แชร์ |
| `CLAUDE.local.md` | ข้อมูลเฉพาะเครื่องเรา เช่น วิธีเลือก Node 20, path ของ Docker, งานที่เรารับผิดชอบ, ภาษาที่อยากให้ Claude ตอบ | ❌ ถูก ignore |

วิธีทำ: เปิด Claude Code ใน repo แล้วพิมพ์ว่า **"ช่วยสร้าง CLAUDE.local.md ให้หน่อย"** Claude จะใช้ template จาก `CLAUDE.md` และถามเราทีละข้อ หรือจะ copy template จากหัวข้อ "Personal setup" ใน `CLAUDE.md` ไปเขียนเองก็ได้

- **ห้าม** ใส่ของเฉพาะเครื่องตัวเองลงใน `CLAUDE.md` เพราะจะทำให้ Claude ของเพื่อนทำงานผิด
- ถ้าเจอเรื่องที่ทุกคนควรรู้ (เช่น gotcha ใหม่) ให้เปิด PR เพิ่มลงใน `CLAUDE.md`

---

## 2. ตั้งชื่อ branch

ใช้รูปแบบ `ประเภท/คำอธิบายสั้นๆ` เป็นภาษาอังกฤษตัวเล็ก คั่นคำด้วย `-`

| ประเภท | ใช้เมื่อ | ตัวอย่าง |
|---|---|---|
| `feature/` | เพิ่มฟีเจอร์ใหม่ | `feature/booking-cancel` |
| `fix/` | แก้บั๊ก | `fix/slot-double-book` |
| `docs/` | แก้เอกสาร | `docs/step2-nginx` |
| `refactor/` | ปรับโครงสร้างโค้ด โดยพฤติกรรมไม่เปลี่ยน | `refactor/payments-repo` |
| `test/` | เพิ่มหรือแก้เทสต์ | `test/bidding-race` |
| `chore/` | config, dependency, Docker | `chore/docker-healthcheck` |

---

## 3. ขั้นตอนทำงานทีละขั้น

### 3.1 เริ่มงานใหม่

```bash
git switch main
git pull
git switch -c feature/booking-cancel
```

### 3.2 ทำงานและ commit

commit บ่อยๆ ทีละก้อนเล็กที่มีความหมายในตัวเอง

```bash
git status
git add lib/modules/booking/
git commit -m "Add cancelBooking service with atomic status check"
```

**การเขียน commit message**
- ใช้ภาษาอังกฤษ ขึ้นต้นด้วยคำกริยา เช่น `Add` / `Fix` / `Update` / `Remove` / `Refactor`
- สั้น กระชับ ไม่เกินประมาณ 70 ตัวอักษร
- ✅ `Fix 409 not returned when slot is already held`
- ❌ `แก้`, `update`, `asdf`, `final2`

### 3.3 อัปเดต branch ตาม main ก่อน push

ระหว่างที่เราทำงาน เพื่อนอาจ merge งานเข้า `main` ไปแล้ว ต้องดึงงานนั้นมาก่อน

```bash
git fetch
git rebase origin/main
npm test                       # ต้องผ่าน
```

ถ้าเจอ conflict ให้ดูหัวข้อ [6. เมื่อเจอ conflict](#6-เมื่อเจอ-conflict)

### 3.4 Push และเปิด Pull Request

```bash
git push -u origin feature/booking-cancel
```

ถ้าเคย push ไปแล้วและเพิ่ง rebase ใหม่ ให้ใช้:

```bash
git push --force-with-lease
```

> ⚠️ ใช้ `--force-with-lease` กับ **branch ของตัวเองเท่านั้น** ห้าม force push ใส่ `main` หรือ branch ที่เพื่อนใช้ด้วย

จากนั้นไปที่ GitHub แล้วกด **Compare & pull request**

### 3.5 สิ่งที่ต้องเขียนใน PR

```markdown
## ทำอะไร
- เพิ่ม endpoint POST /api/bookings/:id/cancel
- ยกเลิกได้เฉพาะ booking ที่สถานะเป็น pending/confirmed

## ทดสอบยังไง
- npm test ผ่านทั้งหมด
- เพิ่มเทสต์ใน test/booking.test.js

## หมายเหตุ
- แก้ openapi.yaml แล้ว
```

แล้ว assign เพื่อนอย่างน้อย **1 คน** ให้รีวิว

### 3.6 Merge

- รอให้มีคน **Approve** อย่างน้อย 1 คน
- ใช้ปุ่ม **Squash and merge** เท่านั้น (1 PR = 1 commit บน `main`)
- คนเปิด PR เป็นคนกด merge เอง

### 3.7 ลบ branch หลัง merge

บน GitHub ให้กด **Delete branch** (หรือถ้าตั้งให้ลบอัตโนมัติไว้แล้ว ก็ไม่ต้องทำ)

ในเครื่องตัวเอง:

```bash
git switch main
git pull
git branch -D feature/booking-cancel
git fetch --prune
```

> ต้องใช้ `-D` ตัวใหญ่ เพราะการ squash merge ทำให้ Git มองว่า branch นี้ยังไม่ได้ merge

**merge แล้วห้ามกลับไป commit ต่อใน branch เดิม** ถ้ามีอะไรต้องแก้เพิ่ม ให้แตก branch ใหม่จาก `main`

---

## 4. การรีวิว PR ของเพื่อน

สิ่งที่ต้องเช็ค:

- [ ] เทสต์ผ่าน (ลอง checkout มารันเองได้ด้วย `gh pr checkout <เลข PR>`)
- [ ] ทำตามกฎ layering: `route → service → repository → db`
  - ไม่มี SQL นอก `lib/modules/*/repository.js`
  - ไม่มี business logic ใน `app/api/**/route.js`
  - ไม่อ่านตารางของ module อื่นตรงๆ
- [ ] ถ้าเพิ่มหรือแก้ API ต้องแก้ `openapi.yaml` ด้วย
- [ ] ไม่มีไฟล์ที่ไม่เกี่ยวข้องติดมา เช่น `.env`, `data/*.db`, `node_modules`

ถ้าเจอปัญหา ให้ comment ในโค้ดแล้วกด **Request changes** ถ้าไม่มีปัญหาก็กด **Approve**

---

## 5. แบ่งงานยังไงให้ conflict น้อย

**แบ่งตาม module** โค้ดแบ่งเป็น bounded context อยู่แล้วใน `lib/modules/*` ถ้าแต่ละคนรับคนละ module จะแทบไม่ชนกันเลย

**ไฟล์ที่ต้องแจ้งทีมก่อนแก้** (บอกในกลุ่มแชทว่า "กำลังแก้ไฟล์ X อยู่"):

| ไฟล์ | เหตุผล |
|---|---|
| `lib/db/schema.js` | ไม่มี migration ทุกคนจึงต้องแก้ไฟล์เดียวกัน |
| `lib/db/seed.js` | เหมือนกับ schema และเทสต์หลายตัวอิงข้อมูลในไฟล์นี้ |
| `openapi.yaml` | ทุกคนที่เพิ่ม route ต้องแก้ไฟล์นี้ |
| `package.json`, `package-lock.json` | dependency ที่ใช้ร่วมกัน (มี 3 ชุด: root, `services/notifications`, `services/payments`) |
| `app/globals.css` | CSS ทั้งเว็บอยู่ในไฟล์เดียว |
| `test/booking.test.js` | เทสต์ assert ว่า order แรกคือ `8001` ห้ามเพิ่ม booking ก่อน subtest แรก |
| `docker-compose.yml` | ทุก Step ต้องเพิ่ม container เช่น Keycloak, RabbitMQ, Prometheus |
| `gateway/nginx.conf` | route ทั้งหมดของระบบอยู่ในไฟล์นี้ |
| `lib/http/auth.js` | ทุก route ใช้ตรวจ token และ Step 3 จะเปลี่ยนไฟล์นี้ทั้งไฟล์ |
| `lib/config.js` | ทุกค่า env อยู่ที่นี่ |
| `test-helpers/*` | เทสต์ทุกไฟล์ใช้ร่วมกัน |

---

## 6. เมื่อเจอ conflict

```bash
git rebase origin/main
# Git จะหยุดและบอกว่าไฟล์ไหน conflict
```

เปิดไฟล์นั้นแล้วหาเครื่องหมายเหล่านี้:

```
<<<<<<< HEAD
โค้ดจาก main
=======
โค้ดของเรา
>>>>>>> Add cancelBooking ...
```

แก้ให้เหลือโค้ดที่ถูกต้อง ลบเครื่องหมายออกให้หมด แล้วรัน:

```bash
git add <ไฟล์ที่แก้แล้ว>
git rebase --continue
npm test
```

ถ้าแก้ไปแล้วงง ให้ยกเลิกแล้วเริ่มใหม่ได้เสมอ:

```bash
git rebase --abort
```

**กรณีพิเศษ:**
- **`package-lock.json` conflict** อย่าแก้ด้วยมือ ให้รัน:
  ```bash
  git checkout --theirs package-lock.json
  npm install
  git add package-lock.json
  git rebase --continue
  ```
- **conflict ในโค้ดที่เพื่อนเขียน** อย่าเดาเอง ให้ถามเจ้าของโค้ดก่อน

---

## 7. สิ่งที่ห้ามทำ

| ❌ ห้าม | ✅ ให้ทำแทน |
|---|---|
| push ตรงเข้า `main` | เปิด PR |
| `git push --force` ใส่ `main` | ไม่มีเหตุผลที่ต้องทำเลย |
| merge PR ตัวเองโดยไม่มีคนรีวิว | รอ approve อย่างน้อย 1 คน |
| branch เดียวทำหลายเรื่อง | แยกเป็นหลาย branch หลาย PR |
| ปล่อย branch ค้างเป็นสัปดาห์ | แบ่งงานให้เล็กลง แล้ว merge บ่อยๆ |
| commit `.env`, `data/*.db`, `node_modules`, `CLAUDE.local.md` | เช็ค `git status` ก่อน `git add` |
| ใส่คำสั่งหรือ path เฉพาะเครื่องตัวเองลงใน `CLAUDE.md` | ใส่ไว้ใน `CLAUDE.local.md` |
| `git add .` โดยไม่ดูว่ามีไฟล์อะไรบ้าง | `git add <path>` หรือดู `git status` ก่อน |
| `npm audit fix --force` | อย่าแตะ version ของ dependency มันถูก pin ไว้ตั้งใจ |
| ใช้ Node 24 ขึ้นไป | ใช้ Node 20 ตาม `.nvmrc` |

---

## 8. คำสั่งที่ใช้บ่อย

```bash
git status                       # ดูว่าแก้อะไรไปบ้าง
git diff                         # ดูรายละเอียดที่แก้ (ยังไม่ add)
git diff --staged                # ดูสิ่งที่ add แล้ว (กำลังจะ commit)
git log --oneline --graph -15    # ดูประวัติ
git branch -a                    # ดู branch ทั้งหมด

git restore <file>               # ทิ้งสิ่งที่แก้ในไฟล์ (ยังไม่ add)
git restore --staged <file>      # เอาออกจาก staged
git commit --amend               # แก้ commit ล่าสุด (เฉพาะที่ยังไม่ push)

git stash                        # เก็บงานที่ทำค้างไว้ชั่วคราว
git stash pop                    # เอางานที่เก็บไว้กลับมา
```

---

## 9. ตั้งค่า GitHub (เจ้าของ repo ทำครั้งเดียว)

**Settings → General → Pull Requests**
- ✅ Allow squash merging (ปิดตัวเลือกอื่น)
- ✅ Automatically delete head branches

**Settings → Branches → Add rule → `main`**
- ✅ Require a pull request before merging
- ✅ Require approvals: 1
- ✅ Require branches to be up to date before merging
- ✅ Do not allow bypassing the above settings

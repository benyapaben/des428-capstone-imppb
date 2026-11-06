# DES428 case-study monoliths — the systems students migrate

Each case study is a **monolith**: one deployable that holds every business capability of an
on-demand platform and owns one database. It is the system a student inherits at the start of the
migration unit and spends the term pulling apart, one seam at a time, into services. They are
deliberately not toys. The courseworks (extract & secure, connect & survive) and the week-15
capstone are only worth doing if the thing being migrated is realistic: real auth, real
persistence, real races, real money, real side effects.

**Using one as your capstone subject.** These are the production-scale track for the capstone
migration project (see `../CAPSTONE.md`). A student who wants a portfolio piece picks one here
instead of the teaching Bangkok Bite lab monolith, and migrates it across the term: extract its
documented seam behind a gateway, secure the hop, give it an event over a broker, make it survive
failure, observe it, and defend it in week 15. The marker grades the migration, not the size of the
monolith — a clean migration of one seam is the target, not extracting every capability.

| Case study | Domain | Origin | Stack | Run | Extract first |
|---|---|---|---|---|---|
| **Bangkok Ride** | ride-hailing | built for the course | Express + EJS + SQLite | `:8080` | Trips |
| **Bangkok Homeservice** | home-services marketplace | built for the course | Next.js (App Router) + SQLite | `:3000` | Providers / Booking |
| **Bangkok Bite** | restaurant ordering & food delivery | FoodKing 4.1 | PHP 8.3 · Laravel 12 · Vue 3 SPA · MySQL 8.4 | `:8201` | Catalog (menu) |
| **Bangkok Delivery** | courier & parcel logistics | We Courier 1.8 | PHP 8.3 · Laravel 12 · Blade · MySQL 8.4 | `:8202` | Pricing |
| **Bangkok Travel** | travel booking marketplace | Booking Core 4.0.2 | PHP 8.2 · Laravel 12 · Blade + Livewire · MySQL 8.4 | `:8203` | Vendor Payouts |
| **Bangkok Marketplace** | multi-vendor shop | Ready eCommerce 4.5.3 | PHP 8.4 · Laravel 13 · Blade + Vue 3 · MySQL 8.4 | `:8204` | Delivery (riders) |

Every one boots with `docker compose up` from its own directory, the same way on Windows (Docker
Desktop, WSL 2 backend), macOS and Linux; nothing else needs installing. The four commercial ones
bake the source into the image and keep state in Docker volumes, so `docker compose up --watch` is
how you edit code live, and `docker compose down -v` resets to first boot. They start with a small
Bangkok demo seed (`docker/seed/bangkok-demo.php`): one login per role, Thai names, THB, Asia/Bangkok,
and one record in every lifecycle state.
Each `README.md` opens with the full tech stack, then the run steps and seeded logins, the roles,
the bounded contexts and the tables each owns, the seam analysis, the teaching hooks (races, money
flow, async points, auth) with `path:line` references, and the known monolith pains.

**Bangkok Bite here is not the lecture monolith.** Weeks 1-15 use a small FastAPI teaching monolith
of the same name. The case study is a different, production-scale PHP system that shares only the
name and the food-delivery domain.

## Two kinds of case study

**Built for the course — Bangkok Ride, Bangkok Homeservice.** Fresh, self-contained monoliths
(one process, one SQLite file) written to a teaching bar: several bounded contexts with a clean
first seam; real transactions and constraints; a domain-event log written in the same transaction
as the state change (the outbox precursor); concurrency races with **correct** guards; hashed
passwords + JWT with role gates; validation, structured logging, typed errors, health checks, an
OpenAPI surface and a real test suite (`docker compose run --rm test`). The products they resemble
were used only as feature references; no code was copied. Bangkok Homeservice was called eDemand
until October 2026, and its code still uses that name internally.

**Real commercial products — Bangkok Bite, Bangkok Delivery, Bangkok Travel, Bangkok Marketplace.**
Laravel + MySQL systems exactly as their vendors ship them: server-rendered admin and partner
panels, a customer web front, and a JSON API that the vendor's Flutter mobile apps call
(`clients/`). This is what inheriting somebody else's system actually looks like. There is no test
suite beyond Laravel's placeholder example tests, and no outbox; side effects (mail, push, SMS, payouts) run inline in the request; and the
races are mostly **unguarded** — each README names them with the line numbers, and fixing them is
part of the work. The mobile apps are a contract: whatever you extract must keep serving them.
These are commercial software: **each student uses their own licensed copy**, and the source is not
committed to the course repositories.

Deliberately **not** present in any of the six, because it is what the course teaches students to
add: an API gateway, an external identity provider, a message broker, an observability stack,
consumer-driven contract tests, and any service extraction.

## The six domains

- **Bangkok Ride** — ride-hailing: riders, drivers (+ documents and admin approval), trips
  (request → match → enroute → completed, plus bid-for-ride and scheduled rides), vehicle classes
  with fare multipliers, an append-only wallet ledger, driver withdrawals, two-way reviews, an
  outbox relay. Seam: **Trips**.
- **Bangkok Homeservice** — home-services marketplace: identity, catalog, provider profiles and
  availability, slot-based bookings with OTP-gated completion, custom-job bidding, payments and
  wallet with an idempotent webhook, reviews, outbox-driven notifications. Seam:
  **Providers/Booking**.
- **Bangkok Bite** — restaurant ordering and delivery: customers order on the web shop or app,
  branch staff run the till (POS), the kitchen screen and dispatch, delivery men deliver, the admin
  runs branches, menu, offers and payments. Seam: **Catalog** — it never calls into the other
  contexts and already has a public read API.
- **Bangkok Delivery** — courier and parcel logistics: merchants book parcels, branch hubs sort and
  move them, delivery men pick up and deliver, cash on delivery is collected and settled to
  merchants. Seam: **Pricing** — admin-owned rate tables with a short list of readers.
- **Bangkok Travel** — travel marketplace: hotels, tours, spaces, cars, events, flights, boats and
  visas listed by vendors and booked by customers, with vendor payouts. Seam: **Vendor Payouts** —
  referenced from one place outside its module and off the checkout path.
- **Bangkok Marketplace** — multi-vendor shop: one checkout across several shops, sellers run their
  own catalogue and orders, riders deliver, the admin approves products, assigns riders, takes a
  commission and pays shops out. Seam: **Delivery** — no other context holds a foreign key into it.

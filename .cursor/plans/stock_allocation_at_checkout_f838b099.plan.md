---
name: Stock allocation at checkout
overview: "Make inventory authoritative at order creation time: atomically decrement `products.stock` in the same Postgres transaction as `INSERT orders`, reject concurrent checkouts cleanly (HTTP 409), remove duplicate decrement from the `shipped` path (and optionally restore stock on `failed`). Update the BFF, optional WebSocket `catalog_changed`, and client-facing error responses."
todos:
  - id: go-tx-allocate
    content: "handleCreateOrder: BEGIN, sort items by product_id, decrement stock with stock>=qty checks, INSERT order, COMMIT; 409 on failure; publish after commit"
    status: completed
  - id: go-shipped-no-dec
    content: "applyShippedDecrementStock: remove product UPDATEs; keep order row lock + idempotent shipped status update only"
    status: completed
  - id: go-failed-restore
    content: "applyStatusUpdate failed: idempotent restore stock from order payload on first transition to failed"
    status: completed
  - id: bff-checkout-409
    content: "checkout: map Go 409 to HTTP 409 and skip cart delete; optional broadcast_all catalog_changed on success"
    status: completed
  - id: ui-409
    content: "Optional: improve App.tsx message for structured insufficient_stock detail"
    status: completed
isProject: false
---

# Concurrency-safe stock: allocate at order creation

## Current behavior ([`services/orders-api/main.go`](services/orders-api/main.go))

- `POST /orders` inserts `pending` and publishes to RabbitMQ **without** touching `products.stock`.
- Stock is decremented only in `applyShippedDecrementStock` when the worker publishes `shipped`, using `UPDATE products SET stock = stock - $qty WHERE id = $id AND stock >= $qty`.

So two browsers can both get `201` and empty carts; the second `shipped` handler fails (0 rows updated), returns an error, and the status consumer **Nack+requeues forever** ([`services/orders-api/rabbit.go`](services/orders-api/rabbit.go) lines 105–108). The DB check constraint prevents negative `stock`, but the system still **oversells promises** and leaves a bad queue/ops state.

```mermaid
sequenceDiagram
  participant B1 as Browser1
  participant B2 as Browser2
  participant Go as orders_api
  participant DB as Postgres
  participant Q as RabbitMQ

  B1->>Go: POST /orders
  B2->>Go: POST /orders
  Go->>DB: INSERT orders (no stock change)
  Go->>DB: INSERT orders (no stock change)
  Go->>Q: order.new x2
  Note over Go,DB: Later: first shipped OK; second shipped errors; message requeued
```

## Recommended approach: single transaction at accept

**Rule:** Decrement stock when the order is **accepted** (same transaction as `INSERT INTO orders`), not when it is **shipped**. Then `shipped` only advances order state (idempotent), matching the idea that inventory is committed at checkout.

| Step | Change |
|------|--------|
| 1 | In `handleCreateOrder`, use `Begin` + **sort line items by `product_id`** (avoid deadlocks), then for each line run `UPDATE products SET stock = stock - $qty WHERE id = $id AND stock >= $qty` and require `RowsAffected() == 1`. On any failure, rollback and respond **409 Conflict** with a small JSON body (e.g. `{"error":"insufficient_stock","product_id":...}` or a list of failing lines). |
| 2 | Only after all decrements succeed, `INSERT` the `pending` order and `COMMIT`, then publish `order.new` as today. |
| 3 | In `applyShippedDecrementStock`, **remove** the product `UPDATE` loop; keep `SELECT ... FOR UPDATE` on the order, idempotent `already shipped`, parse payload only if needed for logging, then `UPDATE orders SET status = 'shipped'`. |
| 4 | **Stock restoration on `failed`:** extend the `failed` branch of `applyStatusUpdate` (or a small helper) so the first transition to `failed` **adds back** line-item quantities to `products.stock` (mirror payload parsing; idempotent if already `failed`). Otherwise inventory is lost when an order is marked failed after allocation-at-create. |

**Publish-after-commit:** If `publishJSON` fails after commit, the order exists and stock is already reduced but the worker never runs — call this out; a minimal mitigation is logging + manual replay, or a follow-up outbox table (out of scope unless you want it now).

## BFF and API surface ([`services/web/app/main.py`](services/web/app/main.py))

- **`POST /api/checkout`:** If Go returns **409**, forward as **409** with a clear `detail` (not **502**). **Do not** delete `cart_items` unless the orders call succeeded.
- **Optional:** On successful checkout, `await ws_manager.broadcast_all({"type": "catalog_changed"})` so other tabs/sessions see updated stock without waiting for a `shipped` notification (since stock now changes at accept, not only at ship).

## Go `POST /orders` response

- Keep `201` + `{"id":"..."}`; optionally add `"status":"pending"` for clarity.
- Document **409** response shape for clients.

## WebSocket ([`services/web/app/main.py`](services/web/app/main.py) + [`services/web/frontend/src/App.tsx`](services/web/frontend/src/App.tsx))

- Existing `order_update` / `catalog_changed` from Go→BFF after status apply ([`bff_notify.go`](services/orders-api/bff_notify.go)) still makes sense for **order lifecycle** and for **shipped**-time side effects you keep (e.g. modal).
- **New:** BFF-driven `catalog_changed` on successful checkout (above) closes the gap for “stock dropped as soon as someone checks out.”
- Frontend already refetches products on `catalog_changed` — no change strictly required if you add the BFF broadcast.

## Frontend

- Checkout already surfaces `body.detail` on error ([`App.tsx`](services/web/frontend/src/App.tsx) ~207–212). Ensure 409 returns a string or structured `detail` the UI can show (“Not enough stock for one or more items”).

## Alternatives (not recommended for this repo’s shape)

- **Pessimistic checkout only in Python:** still races with a second request hitting Go unless the same transaction covers order insert + stock in one service/DB boundary.
- **Keep decrement only on `shipped`:** would require “reservation” rows or similar to reject the second `POST /orders` early; otherwise the oversell + requeue problem remains.

## Files to touch

- [`services/orders-api/main.go`](services/orders-api/main.go) — transactional stock decrement in `handleCreateOrder`; slim `applyShippedDecrementStock`; optional `applyFailedRestoreStock`.
- [`services/web/app/main.py`](services/web/app/main.py) — checkout status mapping; optional `catalog_changed` broadcast.
- [`services/web/frontend/src/App.tsx`](services/web/frontend/src/App.tsx) — only if you want richer handling for structured 409 bodies.

## Verification

- Two sessions, product stock = 1: both add to cart, checkout ~same time → one **201**, one **409**, loser keeps cart.
- Single order through worker → still reaches `shipped`; `products.stock` does **not** drop twice.
- Mark order `failed` (manual or future path) → stock restored once (idempotent second `failed`).

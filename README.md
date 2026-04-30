# Async e-commerce playground

A small demo store that exercises **async messaging** between services: a **FastAPI** backend-for-frontend (with a **React** storefront), a **Go** orders API, **PostgreSQL**, **RabbitMQ**, and a **C++** worker that consumes order jobs and reports status updates.

The browser uses **REST** for products, cart, and checkout, and a **WebSocket** (`/ws`) on the same BFF for **server-pushed order updates**. After the Go service applies a RabbitMQ-driven status change in Postgres, it **POSTs** to an internal Python endpoint; the BFF loads the order row and broadcasts `order_update` (and `catalog_changed` when an order reaches **shipped**, so the UI can refetch product stock) to every socket for that session.

## Architecture

**High-level data flow** (REST, AMQP, DB, and the notify path that fans out over WebSockets):

```mermaid
flowchart LR
  subgraph browser [Browser]
    React[React SPA]
  end
  subgraph py [Python BFF]
    FastAPI[REST /api]
    WSHub[WebSocket /ws]
  end
  subgraph go [Go orders service]
    OrdersAPI[Orders REST]
    StatusConsumer[Status consumer]
  end
  subgraph cpp [C++ worker]
    OrderProc[Order processor]
  end
  React <-->|same origin| FastAPI
  React <-->|/ws| WSHub
  FastAPI -->|checkout| OrdersAPI
  FastAPI -->|products cart| Postgres[(Postgres)]
  OrdersAPI -->|INSERT orders| Postgres
  OrdersAPI -->|publish new_order| RabbitMQ[(RabbitMQ)]
  RabbitMQ -->|consume| OrderProc
  OrderProc -->|publish status| RabbitMQ
  RabbitMQ -->|consume| StatusConsumer
  StatusConsumer -->|UPDATE orders| Postgres
  StatusConsumer -->|"POST /internal/order-events"| FastAPI
  FastAPI -->|read order row| Postgres
  WSHub -->|push JSON| React
```

**Order status notify** (why the UI can drop polling for live status):

```mermaid
sequenceDiagram
  participant React
  participant PythonBFF as Python BFF
  participant GoOrders as Go orders
  participant AMQP as RabbitMQ
  participant DB as Postgres

  React->>PythonBFF: REST cart / checkout / products
  React->>PythonBFF: WebSocket /ws (session)
  AMQP->>GoOrders: order status message
  GoOrders->>DB: apply status (and stock on shipped)
  GoOrders->>PythonBFF: POST /internal/order-events
  Note over GoOrders,PythonBFF: X-Internal-Token, body order_id
  PythonBFF->>DB: load order for session
  PythonBFF-->>React: WS order_update; catalog_changed if shipped
  Note over React: Refetch products on catalog_changed; shipped modal on transition
```

## What runs where

| Service | Role |
|---------|------|
| `web` | Storefront UI, cart/products **REST**, **WebSocket** hub, and **internal** notify handler; talks to Postgres and the orders API |
| `go-orders` | Creates orders, persists them, publishes work to RabbitMQ; consumes status updates, updates Postgres, **notifies** the BFF over HTTP when configured |
| `cpp-worker` | Processes orders from the queue (two replicas in Compose) |
| `postgres` | Products, cart, orders |
| `rabbitmq` | Message broker (management UI included) |

## Environment (Compose)

The Go service calls the Python app on the Docker network after a successful status apply. Values must stay in sync where noted.

| Variable | Service | Purpose |
|----------|---------|---------|
| `BFF_NOTIFY_URL` | `go-orders` | e.g. `http://web:8000/internal/order-events`; empty skips notify (e.g. some local tests) |
| `INTERNAL_EVENTS_SECRET` | `web`, `go-orders` | Same shared secret; sent as `X-Internal-Token` on internal POST |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- [GNU Make](https://www.gnu.org/software/make/) (optional; you can use `docker compose` directly)

## Quick start

From the project root:

```bash
make up
```

Or:

```bash
docker compose up -d
```

To rebuild images after code changes:

```bash
docker compose up -d --build --remove-orphans
```

The Makefile loads `.env` (see `PROJECT_NAME` there). Stop everything with `make down` or `docker compose down`.

## URLs and ports

| What | URL / port |
|------|------------|
| Storefront | http://localhost:3000 |
| Orders API | http://localhost:8080 |
| RabbitMQ management | http://localhost:15672 (user `app`, password `app` in the default Compose file) |
| Postgres | `localhost:5432` (user `app`, password `app`, database `app`) |

## Local development notes

- **Web**: Python app in `services/web/app` (REST, `/ws`, `/internal/order-events`), frontend in `services/web/frontend` (built into `dist` for the container image). Vite dev proxy maps `/api` and `/ws` to the local BFF.
- **Orders API**: Go service in `services/orders-api`.
- **Worker**: C++ service in `services/order-worker`.
- **Schema / seed data**: `postgres/init.sql`.

This repo is for learning and experimentation; default credentials and secrets in Compose are not production-safe.

# Async e-commerce playground

A small demo store that exercises **async messaging** between services: a **FastAPI** backend-for-frontend (with a **React** storefront), a **Go** orders API, **PostgreSQL**, **RabbitMQ**, and a **C++** worker that consumes order jobs and reports status updates.

## What runs where

| Service        | Role |
|----------------|------|
| `web`          | Storefront UI + cart APIs; talks to Postgres and the orders API |
| `go-orders`    | Creates orders, persists them, publishes work to RabbitMQ |
| `cpp-worker`   | Processes orders from the queue (two replicas in Compose) |
| `postgres`     | Products, cart, orders |
| `rabbitmq`     | Message broker (management UI included) |

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

- **Web**: Python app in `services/web/app`, frontend in `services/web/frontend` (built into `dist` for the container image).
- **Orders API**: Go service in `services/orders-api`.
- **Worker**: C++ service in `services/order-worker`.
- **Schema / seed data**: `postgres/init.sql`.

This repo is for learning and experimentation; default credentials and secrets in Compose are not production-safe.

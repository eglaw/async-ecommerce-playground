import asyncio
import json
import os
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware

DATABASE_URL = os.environ.get("DATABASE_URL", "")
ORDERS_API_URL = os.environ.get("ORDERS_API_URL", "http://localhost:8080").rstrip("/")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "dev-insecure-secret")
INTERNAL_EVENTS_SECRET = os.environ.get("INTERNAL_EVENTS_SECRET", "").strip()
DIST_DIR = Path(__file__).resolve().parent.parent / "dist"


@contextmanager
def get_conn():
    conn = psycopg.connect(DATABASE_URL)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def session_id(request: Request) -> str:
    sid = request.session.get("sid")
    if not sid:
        sid = str(uuid.uuid4())
        request.session["sid"] = sid
    return sid


class ConnectionManager:
    def __init__(self) -> None:
        self._by_session: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, session_key: str, ws: WebSocket) -> None:
        async with self._lock:
            self._by_session.setdefault(session_key, set()).add(ws)

    async def disconnect(self, session_key: str, ws: WebSocket) -> None:
        async with self._lock:
            bucket = self._by_session.get(session_key)
            if bucket:
                bucket.discard(ws)
                if not bucket:
                    del self._by_session[session_key]

    async def broadcast_session(self, session_key: str, message: dict[str, Any]) -> None:
        text = json.dumps(message)
        async with self._lock:
            targets = list(self._by_session.get(session_key, ()))
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(session_key, ws)

    async def broadcast_all(self, message: dict[str, Any]) -> None:
        text = json.dumps(message)
        async with self._lock:
            by_session = [
                (sess, list(bucket)) for sess, bucket in self._by_session.items()
            ]
        dead: list[tuple[str, WebSocket]] = []
        for sess, targets in by_session:
            for ws in targets:
                try:
                    await ws.send_text(text)
                except Exception:
                    dead.append((sess, ws))
        for sess, ws in dead:
            await self.disconnect(sess, ws)


ws_manager = ConnectionManager()

app = FastAPI(title="Storefront BFF")
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, same_site="lax")


def _order_row_to_api(
    row: tuple[Any, ...],
) -> dict[str, Any]:
    oid, sess, status, payload, created_at, updated_at = row
    if isinstance(payload, (dict, list)):
        payload_obj: Any = payload
    else:
        payload_obj = json.loads(payload) if payload else {}
    return {
        "id": oid,
        "session_id": sess,
        "status": status,
        "payload": payload_obj,
        "created_at": created_at.isoformat(),
        "updated_at": updated_at.isoformat(),
    }


def fetch_order_row(order_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id::text, session_id, status, payload, created_at, updated_at
                FROM orders WHERE id = %s::uuid
                """,
                (order_id,),
            )
            row = cur.fetchone()
    if not row:
        return None
    return _order_row_to_api(row)


class CartItemIn(BaseModel):
    product_id: int = Field(ge=1)
    qty: int = Field(ge=1)


@app.get("/api/products")
def list_products(request: Request):
    session_id(request)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, price_cents, stock FROM products ORDER BY id"
            )
            rows = cur.fetchall()
    return [
        {"id": r[0], "name": r[1], "price_cents": r[2], "stock": r[3]} for r in rows
    ]


@app.get("/api/cart")
def get_cart(request: Request):
    sid = session_id(request)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.name, p.price_cents, p.stock, c.qty
                FROM cart_items c
                JOIN products p ON p.id = c.product_id
                WHERE c.session_id = %s
                ORDER BY p.id
                """,
                (sid,),
            )
            rows = cur.fetchall()
    return [
        {
            "product_id": r[0],
            "name": r[1],
            "price_cents": r[2],
            "stock": r[3],
            "qty": r[4],
        }
        for r in rows
    ]


@app.post("/api/cart/items")
def add_cart_item(request: Request, body: CartItemIn):
    sid = session_id(request)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT stock FROM products WHERE id = %s FOR UPDATE",
                (body.product_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="product not found")
            stock = row[0]
            cur.execute(
                "SELECT qty FROM cart_items WHERE session_id = %s AND product_id = %s",
                (sid, body.product_id),
            )
            existing = cur.fetchone()
            current = existing[0] if existing else 0
            if current + body.qty > stock:
                raise HTTPException(status_code=400, detail="not enough stock")
            cur.execute(
                """
                INSERT INTO cart_items (session_id, product_id, qty)
                VALUES (%s, %s, %s)
                ON CONFLICT (session_id, product_id) DO UPDATE
                SET qty = cart_items.qty + EXCLUDED.qty
                """,
                (sid, body.product_id, body.qty),
            )
    return {"ok": True}


@app.delete("/api/cart/items/{product_id}")
def remove_cart_item(request: Request, product_id: int):
    sid = session_id(request)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM cart_items WHERE session_id = %s AND product_id = %s",
                (sid, product_id),
            )
    return {"ok": True}


@app.post("/api/checkout")
async def checkout(request: Request):
    sid = session_id(request)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.name, p.price_cents, c.qty
                FROM cart_items c
                JOIN products p ON p.id = c.product_id
                WHERE c.session_id = %s
                ORDER BY p.id
                """,
                (sid,),
            )
            rows = cur.fetchall()
    if not rows:
        raise HTTPException(status_code=400, detail="cart is empty")

    items = [
        {
            "product_id": r[0],
            "name": r[1],
            "qty": r[3],
            "price_cents": r[2],
        }
        for r in rows
    ]
    payload = {"session_id": sid, "items": items}

    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{ORDERS_API_URL}/orders", json=payload, timeout=30.0
            )
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"orders service: {e}") from e

    if r.status_code == 409:
        try:
            go_body = r.json()
        except Exception:
            go_body = None
        if isinstance(go_body, dict):
            raise HTTPException(status_code=409, detail=go_body)
        raise HTTPException(
            status_code=409,
            detail=r.text or "insufficient stock",
        )

    if r.status_code >= 400:
        raise HTTPException(
            status_code=502, detail=r.text or "orders service error"
        )

    data = r.json()
    order_id = data.get("id")
    if not order_id:
        raise HTTPException(status_code=502, detail="invalid orders response")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM cart_items WHERE session_id = %s",
                (sid,),
            )

    await ws_manager.broadcast_all({"type": "catalog_changed"})
    status = data.get("status") or "pending"

    return {"order_id": order_id, "status": status}


@app.get("/api/orders/{order_id}")
def get_order_proxy(request: Request, order_id: str):
    session_id(request)
    try:
        r = httpx.get(f"{ORDERS_API_URL}/orders/{order_id}", timeout=15.0)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"orders service: {e}") from e
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="not found")
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=r.text)
    return r.json()


class InternalOrderEvent(BaseModel):
    order_id: str


@app.post("/internal/order-events")
async def internal_order_events(request: Request, body: InternalOrderEvent):
    if not INTERNAL_EVENTS_SECRET:
        raise HTTPException(
            status_code=503, detail="internal events not configured"
        )
    token = request.headers.get("X-Internal-Token", "")
    if token != INTERNAL_EVENTS_SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")

    order = fetch_order_row(body.order_id.strip())
    if not order:
        raise HTTPException(status_code=404, detail="order not found")

    sess = order["session_id"]
    await ws_manager.broadcast_session(sess, {"type": "order_update", "order": order})
    if str(order["status"]).lower().strip() == "shipped":
        await ws_manager.broadcast_all({"type": "catalog_changed"})

    return {"ok": True}


@app.websocket("/ws")
async def ws_storefront(websocket: WebSocket):
    # Request() only supports scope["type"] == "http"; use session dict from SessionMiddleware on scope.
    sess = websocket.scope.setdefault("session", {})
    sid = sess.get("sid")
    if not sid:
        sid = str(uuid.uuid4())
        sess["sid"] = sid
    await websocket.accept()
    await ws_manager.connect(sid, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(sid, websocket)


@app.get("/health")
def health():
    return {"ok": True}


if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="spa")

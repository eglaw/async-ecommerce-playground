import os
import uuid
from contextlib import contextmanager
from pathlib import Path

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware

DATABASE_URL = os.environ.get("DATABASE_URL", "")
ORDERS_API_URL = os.environ.get("ORDERS_API_URL", "http://localhost:8080").rstrip("/")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "dev-insecure-secret")
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


app = FastAPI(title="Storefront BFF")
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, same_site="lax")


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
def checkout(request: Request):
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
        r = httpx.post(f"{ORDERS_API_URL}/orders", json=payload, timeout=30.0)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"orders service: {e}") from e

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

    return {"order_id": order_id}


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


if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="spa")


@app.get("/health")
def health():
    return {"ok": True}

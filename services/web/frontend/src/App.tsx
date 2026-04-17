import { useCallback, useEffect, useState } from "react";

type Product = {
  id: number;
  name: string;
  price_cents: number;
  stock: number;
};

type CartLine = {
  product_id: number;
  name: string;
  price_cents: number;
  stock: number;
  qty: number;
};

type OrderStatus = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

function formatPrice(cents: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState<OrderStatus | null>(null);

  const loadProducts = useCallback(async () => {
    const r = await fetch("/api/products", { credentials: "include" });
    if (!r.ok) throw new Error(await r.text());
    setProducts(await r.json());
  }, []);

  const loadCart = useCallback(async () => {
    const r = await fetch("/api/cart", { credentials: "include" });
    if (!r.ok) throw new Error(await r.text());
    setCart(await r.json());
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      await Promise.all([loadProducts(), loadCart()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [loadProducts, loadCart]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!activeOrderId) {
      setOrderStatus(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/orders/${activeOrderId}`, {
          credentials: "include",
        });
        if (!r.ok) return;
        const data = (await r.json()) as OrderStatus;
        if (!cancelled) setOrderStatus(data);
      } catch {
        /* ignore poll errors */
      }
    };
    void tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeOrderId]);

  async function addToCart(product: Product) {
    setError(null);
    const r = await fetch("/api/cart/items", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: product.id, qty: 1 }),
    });
    if (!r.ok) {
      setError((await r.json().catch(() => ({})))?.detail ?? r.statusText);
      return;
    }
    await loadCart();
  }

  async function removeLine(productId: number) {
    setError(null);
    const r = await fetch(`/api/cart/items/${productId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!r.ok) {
      setError(await r.text());
      return;
    }
    await loadCart();
  }

  async function checkout() {
    setError(null);
    setCheckoutLoading(true);
    setActiveOrderId(null);
    setOrderStatus(null);
    try {
      const r = await fetch("/api/checkout", {
        method: "POST",
        credentials: "include",
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(
          typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail ?? r.statusText)
        );
        return;
      }
      const id = body.order_id as string;
      setActiveOrderId(id);
      await loadCart();
      await loadProducts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "checkout failed");
    } finally {
      setCheckoutLoading(false);
    }
  }

  const cartTotal = cart.reduce(
    (sum, l) => sum + l.price_cents * l.qty,
    0
  );

  return (
    <main>
      <h1>Products</h1>
      {error ? <p className="error">{error}</p> : null}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="grid">
          {products.map((p) => (
            <div key={p.id} className="card">
              <h2>{p.name}</h2>
              <p className="muted">
                {formatPrice(p.price_cents)} · {p.stock} in stock
              </p>
              <div className="row" style={{ marginTop: "0.75rem" }}>
                <button
                  type="button"
                  onClick={() => void addToCart(p)}
                  disabled={p.stock < 1}
                >
                  Add to cart
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <h2>Cart</h2>
        {cart.length === 0 ? (
          <p className="muted">Your cart is empty.</p>
        ) : (
          <>
            {cart.map((line) => (
              <div key={line.product_id} className="cart-line">
                <span>
                  {line.name} × {line.qty}{" "}
                  <span className="muted">
                    ({formatPrice(line.price_cents * line.qty)})
                  </span>
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void removeLine(line.product_id)}
                >
                  Remove
                </button>
              </div>
            ))}
            <p style={{ marginTop: "0.75rem" }}>
              <strong>Total:</strong> {formatPrice(cartTotal)}
            </p>
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button
                type="button"
                onClick={() => void checkout()}
                disabled={checkoutLoading}
              >
                {checkoutLoading ? "Placing order…" : "Checkout"}
              </button>
            </div>
          </>
        )}
      </div>

      {activeOrderId ? (
        <div className="panel">
          <h2>Order {activeOrderId}</h2>
          {!orderStatus ? (
            <p className="muted">Waiting for status…</p>
          ) : (
            <>
              <p>
                Status:{" "}
                <span className="badge">{orderStatus.status}</span>
              </p>
              <p className="muted">
                Updated: {new Date(orderStatus.updated_at).toLocaleString()}
              </p>
            </>
          )}
        </div>
      ) : null}
    </main>
  );
}

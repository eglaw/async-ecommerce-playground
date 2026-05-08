import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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

type OrderItemRow = {
  product_id: number;
  name: string;
  qty: number;
  price_cents: number;
};

type OrderDetail = {
  id: string;
  session_id: string;
  status: string;
  payload: { items?: OrderItemRow[] };
  created_at: string;
  updated_at: string;
};

type WsOrderUpdate = { type: "order_update"; order: OrderDetail };
type WsCatalogChanged = { type: "catalog_changed" };
type WsMessage = WsOrderUpdate | WsCatalogChanged;

function formatPrice(cents: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatCheckoutErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((x) => JSON.stringify(x)).join(", ");
  }
  if (detail && typeof detail === "object") {
    const o = detail as Record<string, unknown>;
    if (o.error === "insufficient_stock") {
      const pid = o.product_id;
      if (typeof pid === "number") {
        return `Not enough stock to complete checkout (product id ${pid}). Another order may have claimed the remaining inventory. Refresh and adjust your cart.`;
      }
      return "Not enough stock to complete checkout. Refresh and adjust your cart.";
    }
  }
  if (detail === undefined || detail === null) return fallback;
  try {
    return JSON.stringify(detail);
  } catch {
    return fallback;
  }
}

function wsBaseUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState<OrderDetail | null>(null);
  const [shippedModal, setShippedModal] = useState<OrderDetail | null>(null);

  const activeOrderIdRef = useRef<string | null>(null);
  const prevStatusRef = useRef<string | null>(null);

  useEffect(() => {
    activeOrderIdRef.current = activeOrderId;
  }, [activeOrderId]);

  useEffect(() => {
    if (!activeOrderId) {
      prevStatusRef.current = null;
      return;
    }
    const st = orderStatus?.status?.toLowerCase().trim();
    if (st === undefined) return;
    const prev = prevStatusRef.current;
    if (prev !== "shipped" && st === "shipped") {
      setShippedModal(orderStatus);
    }
    prevStatusRef.current = st;
  }, [orderStatus, activeOrderId]);

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

  const fetchOrderSnapshot = useCallback(async (orderId: string) => {
    try {
      const r = await fetch(`/api/orders/${orderId}`, {
        credentials: "include",
      });
      if (!r.ok) return;
      const data = (await r.json()) as OrderDetail;
      setOrderStatus(data);
    } catch {
      /* ignore */
    }
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
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${wsBaseUrl()}/ws`);
    } catch {
      return;
    }

    ws.onmessage = (ev) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(ev.data as string) as WsMessage;
      } catch {
        return;
      }
      if (msg.type === "catalog_changed") {
        void loadProducts();
        return;
      }
      if (msg.type === "order_update") {
        if (msg.order.id === activeOrderIdRef.current) {
          setOrderStatus(msg.order);
        }
      }
    };

    return () => {
      ws?.close();
    };
  }, [loadProducts]);

  useEffect(() => {
    if (!activeOrderId) {
      setOrderStatus(null);
      prevStatusRef.current = null;
      return;
    }
    void fetchOrderSnapshot(activeOrderId);
  }, [activeOrderId, fetchOrderSnapshot]);

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
    prevStatusRef.current = null;
    try {
      const r = await fetch("/api/checkout", {
        method: "POST",
        credentials: "include",
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(
          formatCheckoutErrorDetail(body.detail, r.statusText)
        );
        return;
      }
      const id = body.order_id as string;
      setActiveOrderId(id);
      await loadCart();
      await loadProducts();
      await fetchOrderSnapshot(id);
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

  const modalItems = shippedModal?.payload?.items ?? [];

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
                Updated:{" "}
                {new Date(orderStatus.updated_at).toLocaleString()}
              </p>
            </>
          )}
        </div>
      ) : null}

      {shippedModal ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShippedModal(null)}
        >
          <div
            className="modal-dialog"
            role="dialog"
            aria-labelledby="shipped-modal-title"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="shipped-modal-title">Order shipped</h2>
            <p className="muted modal-order-id">{shippedModal.id}</p>
            <p style={{ marginTop: "0.75rem" }}>
              Placed{" "}
              {new Date(shippedModal.created_at).toLocaleString()} · Updated{" "}
              {new Date(shippedModal.updated_at).toLocaleString()}
            </p>
            <h3 style={{ margin: "1rem 0 0.5rem", fontSize: "1rem" }}>
              Items
            </h3>
            {modalItems.length === 0 ? (
              <p className="muted">No line items in payload.</p>
            ) : (
              <ul className="modal-items">
                {modalItems.map((it) => (
                  <li key={`${it.product_id}-${it.name}`}>
                    <span>{it.name}</span>
                    <span className="muted">
                      × {it.qty} ({formatPrice(it.price_cents * it.qty)})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions row">
              <button type="button" onClick={() => setShippedModal(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

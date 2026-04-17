CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS cart_items (
    session_id TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    qty INTEGER NOT NULL CHECK (qty > 0),
    PRIMARY KEY (session_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_session ON orders (session_id);

INSERT INTO products (name, price_cents, stock) VALUES
    ('Widget A', 999, 100),
    ('Widget B', 1499, 50),
    ('Gadget', 2499, 25);

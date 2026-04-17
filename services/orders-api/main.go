package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
)

type orderItem struct {
	ProductID  int    `json:"product_id"`
	Name       string `json:"name"`
	Qty        int    `json:"qty"`
	PriceCents int    `json:"price_cents"`
}

type createOrderRequest struct {
	SessionID string      `json:"session_id"`
	Items     []orderItem `json:"items"`
}

type orderRow struct {
	ID        string          `json:"id"`
	SessionID string          `json:"session_id"`
	Status    string          `json:"status"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type newOrderMessage struct {
	OrderID   string      `json:"order_id"`
	SessionID string      `json:"session_id"`
	Items     []orderItem `json:"items"`
}

type statusMessage struct {
	OrderID string `json:"order_id"`
	Status  string `json:"status"`
	Detail  string `json:"detail,omitempty"`
}

type appState struct {
	pool *pgxpool.Pool
	ch   *amqp.Channel
}

func (a *appState) applyStatusUpdate(body []byte) error {
	var m statusMessage
	if err := json.Unmarshal(body, &m); err != nil {
		log.Printf("status consumer: bad json (%d bytes): %v", len(body), err)
		return err
	}
	status := strings.ToLower(strings.TrimSpace(m.Status))
	switch status {
	case "processing", "shipped", "failed":
	default:
		log.Printf("status consumer: invalid status %q for order %s", m.Status, m.OrderID)
		return fmt.Errorf("invalid status: %q", m.Status)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tag, err := a.pool.Exec(ctx,
		`UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1::uuid`,
		m.OrderID, status,
	)
	if err != nil {
		log.Printf("status consumer: db update failed order=%s status=%s: %v", m.OrderID, status, err)
		return err
	}
	if tag.RowsAffected() == 0 {
		log.Printf("status consumer: no row for order=%s (status=%s)", m.OrderID, status)
		return fmt.Errorf("order not found: %s", m.OrderID)
	}
	detail := m.Detail
	if len(detail) > 120 {
		detail = detail[:120] + "…"
	}
	log.Printf("status consumer: order=%s -> %s (%s)", m.OrderID, status, detail)
	return nil
}

func main() {
	log.SetPrefix("[go-orders] ")
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	amqpURL := os.Getenv("AMQP_URL")
	if amqpURL == "" {
		log.Fatal("AMQP_URL is required")
	}
	httpAddr := os.Getenv("HTTP_ADDR")
	if httpAddr == "" {
		httpAddr = ":8080"
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()
	log.Print("postgres pool ready")

	conn, err := amqp.Dial(amqpURL)
	if err != nil {
		log.Fatalf("amqp dial: %v", err)
	}
	defer conn.Close()
	log.Print("rabbitmq connection open")

	pubCh, err := conn.Channel()
	if err != nil {
		log.Fatalf("amqp channel: %v", err)
	}
	if err := declareTopology(pubCh); err != nil {
		log.Fatalf("topology: %v", err)
	}
	log.Printf("publisher channel ready (exchange=%s route=%s)", exchangeName, routingNew)

	consCh, err := conn.Channel()
	if err != nil {
		log.Fatalf("amqp consumer channel: %v", err)
	}
	if err := declareTopology(consCh); err != nil {
		log.Fatalf("topology consumer: %v", err)
	}

	app := &appState{pool: pool, ch: pubCh}
	log.Printf("starting status consumer (queue=%s)", queueStatus)
	go consumeStatusLoop(consCh, app)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /orders", app.handleCreateOrder)
	mux.HandleFunc("GET /orders/{id}", app.handleGetOrder)

	srv := &http.Server{Addr: httpAddr, Handler: mux}

	go func() {
		log.Printf("listening %s", httpAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	shCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shCtx)
}

func (a *appState) handleCreateOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req createOrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("POST /orders: invalid json: %v", err)
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	req.SessionID = strings.TrimSpace(req.SessionID)
	if req.SessionID == "" || len(req.Items) == 0 {
		log.Print("POST /orders: missing session_id or items")
		http.Error(w, "session_id and items required", http.StatusBadRequest)
		return
	}
	log.Printf("POST /orders: session_id=%s items=%d remote=%s", req.SessionID, len(req.Items), r.RemoteAddr)

	payload, err := json.Marshal(map[string]any{
		"items": req.Items,
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	var orderID string
	err = a.pool.QueryRow(ctx, `
		INSERT INTO orders (id, session_id, status, payload)
		VALUES (gen_random_uuid(), $1, 'pending', $2::jsonb)
		RETURNING id::text`,
		req.SessionID, payload,
	).Scan(&orderID)
	if err != nil {
		log.Printf("insert order failed: %v", err)
		http.Error(w, "could not create order", http.StatusInternalServerError)
		return
	}

	msg := newOrderMessage{
		OrderID:   orderID,
		SessionID: req.SessionID,
		Items:     req.Items,
	}
	msgBody, err := json.Marshal(msg)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := publishJSON(a.ch, routingNew, msgBody); err != nil {
		log.Printf("publish order.new: %v", err)
		http.Error(w, "could not enqueue order", http.StatusInternalServerError)
		return
	}
	log.Printf("published order.new order_id=%s bytes=%d", orderID, len(msgBody))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"id": orderID})
	log.Printf("POST /orders: created order_id=%s status=pending", orderID)
}

func (a *appState) handleGetOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var row orderRow
	err := a.pool.QueryRow(ctx, `
		SELECT id::text, session_id, status, payload, created_at, updated_at
		FROM orders WHERE id = $1::uuid`,
		id,
	).Scan(&row.ID, &row.SessionID, &row.Status, &row.Payload, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		log.Printf("GET /orders/%s: not found", id)
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(row)
}

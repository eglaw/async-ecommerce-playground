package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type bffOrderEvent struct {
	OrderID string `json:"order_id"`
}

func notifyBFF(orderID string) {
	url := strings.TrimSpace(os.Getenv("BFF_NOTIFY_URL"))
	if url == "" {
		return
	}
	secret := strings.TrimSpace(os.Getenv("INTERNAL_EVENTS_SECRET"))
	if secret == "" {
		log.Print("bff notify: INTERNAL_EVENTS_SECRET empty, skip")
		return
	}

	body, err := json.Marshal(bffOrderEvent{OrderID: strings.TrimSpace(orderID)})
	if err != nil {
		log.Printf("bff notify: marshal: %v", err)
		return
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("bff notify: new request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", secret)

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("bff notify: post order_id=%s: %v", orderID, err)
		return
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("bff notify: order_id=%s status=%s", orderID, resp.Status)
	}
}

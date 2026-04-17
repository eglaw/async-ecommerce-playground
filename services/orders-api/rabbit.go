package main

import (
	"context"
	"fmt"
	"log"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const (
	exchangeName   = "orders.events"
	queueNew       = "orders.new"
	queueStatus    = "orders.status"
	routingNew     = "order.new"
	routingStatus  = "order.status"
)

func declareTopology(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare(
		exchangeName,
		"topic",
		true,
		false,
		false,
		false,
		nil,
	); err != nil {
		return fmt.Errorf("exchange declare: %w", err)
	}
	if _, err := ch.QueueDeclare(
		queueNew,
		true,
		false,
		false,
		false,
		nil,
	); err != nil {
		return fmt.Errorf("queue new: %w", err)
	}
	if err := ch.QueueBind(queueNew, routingNew, exchangeName, false, nil); err != nil {
		return fmt.Errorf("bind new: %w", err)
	}
	if _, err := ch.QueueDeclare(
		queueStatus,
		true,
		false,
		false,
		false,
		nil,
	); err != nil {
		return fmt.Errorf("queue status: %w", err)
	}
	if err := ch.QueueBind(queueStatus, routingStatus, exchangeName, false, nil); err != nil {
		return fmt.Errorf("bind status: %w", err)
	}
	return nil
}

func publishJSON(ch *amqp.Channel, routingKey string, body []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return ch.PublishWithContext(ctx,
		exchangeName,
		routingKey,
		false,
		false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Body:         body,
		},
	)
}

func consumeStatusLoop(ch *amqp.Channel, app *appState) {
	msgs, err := ch.Consume(
		queueStatus,
		"go-orders-status",
		false,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		log.Fatalf("consume status: %v", err)
	}
	log.Print("status consumer: subscribed, waiting for deliveries")
	for d := range msgs {
		log.Printf("status consumer: delivery tag=%d body=%dB exchange=%q route=%q",
			d.DeliveryTag, len(d.Body), d.Exchange, d.RoutingKey)
		if err := app.applyStatusUpdate(d.Body); err != nil {
			log.Printf("status consumer: apply failed, nack+requeue: %v", err)
			_ = d.Nack(false, true)
			continue
		}
		if err := d.Ack(false); err != nil {
			log.Printf("status consumer: ack error: %v", err)
			continue
		}
		log.Printf("status consumer: ack tag=%d", d.DeliveryTag)
	}
}

# Implementation Plan: Event-Driven Architecture

This document outlines the step-by-step plan to implement the event-driven architecture described in `spec.md`.

## Step 1: Project Setup

1.  **Modify `docker-compose.yml`**: Add the Redpanda service and configure the `api` service to depend on it.
2.  **Update `.env.example`**: Add the `REDPANDA_BROKER` environment variable.

## Step 2: Install Dependencies

1.  **Install `kafkajs`**: Add the `kafkajs` library to the project's `package.json`.

## Step 3: Create Event Publisher Service

1.  **Create `event-publisher.js`**: This file will contain the logic for connecting to Redpanda and publishing events.
    *   Implement `connectProducer` function.
    *   Implement `disconnectProducer` function.
    *   Implement `publishEvent` function.

## Step 4: Integrate Event Publishing

1.  **Modify `pwd-service.js`**:
    *   Import the `publishEvent` function.
    *   Publish `VPS_PROGRESS` events during the `createPwdSession` process.
    *   Publish `VPS_ERROR` events if any errors occur.

2.  **Modify `routes/vps.js`**:
    *   Import the `publishEvent` function.
    *   In the `POST /` route, publish a `VPS_CREATED` event after a session is successfully created.
    *   In the `DELETE /:id` route, publish a `SESSION_CLOSED` event after a session is successfully closed.

## Step 5: Create Example Consumer

1.  **Create `consumer.js`**: This script will be used to test and demonstrate how to consume events from Redpanda.
    *   Implement a Kafka consumer that subscribes to the `vde.vps.lifecycle` and `vde.vps.progress` topics.
    *   Log the received events to the console.

## Step 6: Update `package.json`

1.  **Add Consumer Script**: Add a new script to `package.json` to easily run the consumer (e.g., `npm run start:consumer`).

## Step 7: Verification

1.  **Start Services**: Run `docker-compose up --build` to start the `api` and `redpanda` services.
2.  **Run Consumer**: In a separate terminal, run the consumer script.
3.  **Test API Endpoints**: Use an API client to send requests to the `POST /api/v1/vps` and `DELETE /api/v1/vps/{id}` endpoints.
4.  **Verify Events**: Confirm that the correct events are published by the API and received by the consumer.

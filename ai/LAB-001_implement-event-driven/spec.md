# Story: LAB-001 - Implement Event-Driven Architecture

## 1. Goal

Enhance the Virtual Development Environment API by publishing events at key points in the Play with Docker (PWD) session lifecycle. This will enable other microservices to subscribe and react to these events asynchronously, creating a more decoupled and scalable system.

## 2. Proposed Architecture

We will introduce an event-driven architecture using a Kafka-compatible message broker.

*   **Producer:** The existing Node.js API (`dev-lab`) will be responsible for publishing events.
*   **Event Broker:** Redpanda will be used as the event broker. It will be configured in `docker-compose.yml` for local development.
*   **Consumers:** Any authorized microservice can subscribe to event topics to perform actions like sending notifications, updating dashboards, or collecting audit logs.

### 2.1. Event Topics

The following Kafka topics will be used to categorize events:

*   `vde.vps.lifecycle`: For major state changes in the VPS lifecycle (e.g., created, closed, expired).
*   `vde.vps.progress`: For step-by-step status updates during long-running operations (e.g., authentication steps, instance provisioning).
*   `vde.vps.errors`: For broadcasting errors that occur during VPS operations.

## 3. Event Schema

All events will be JSON objects with a consistent base structure.

**Base Schema:**
```json
{
  "eventType": "string",
  "timestamp": "ISO8601",
  "id": "string",
  "data": {}
}
```

---

### Example Events

**1. VPS Created Event (`vde.vps.lifecycle`)**

Published after a new PWD session is successfully created and its details are stored in the database.

*Payload:*
```json
{
  "eventType": "VPS_CREATED",
  "timestamp": "2025-07-12T10:00:00.000Z",
  "id": "d1pfpoa91nsg0087r370",
  "data": {
    "id": 1,
    "pwdSessionId": "d1pfpoa91nsg0087r370",
    "sessionUrl": "https://labs.play-with-docker.com/p/d1pfpoa91nsg0087r370",
    "publicIp": "104.18.12.123",
    "sshString": "ssh ip104-18-12-123-abcde.direct.labs.play-with-docker.com",
    "diskUsage": 5,
    "createdAt": "2025-07-12T10:00:00.000Z",
    "expiresAt": "2025-07-12T14:00:00.000Z"
  }
}
```
*Note: The `data` object directly reflects the session object created in `pwd-service.js` and stored in the database.*

---

**2. VPS Progress Event (`vde.vps.progress`)**

Published during the `createPwdSession` process to provide real-time feedback.

*Payload:*
```json
{
  "eventType": "VPS_PROGRESS",
  "timestamp": "2025-07-12T10:01:00.000Z",
  "id": "temp-session-id-12345",
  "data": {
    "step": "AUTHENTICATION_SUCCESS",
    "message": "Docker Hub authentication completed successfully."
  }
}
```

---

**3. Session Closed Event (`vde.vps.lifecycle`)**

Published when a user or the API successfully closes a session via the `DELETE /api/v1/vps/{id}` endpoint.

*Payload:*
```json
{
  "eventType": "VPS_CLOSED",
  "timestamp": "2025-07-12T14:00:00.000Z",
  "id": "d1pfpoa91nsg0087r370",
  "data": {
    "reason": "User requested closure via API."
  }
}
```

## 4. Implementation Plan

### Step 1: Update Project Setup

1.  **Add Redpanda to `docker-compose.yml`**:
    A Redpanda service will be added to run alongside the API for local development. The `api` service will be updated to depend on it.

    ```yaml
    version: '3.8'
    services:
      redpanda:
        image: docker.redpanda.com/redpandadata/redpanda:latest
        container_name: redpanda
        ports:
          - "9092:9092"
          - "9644:9644"
        command:
          - redpanda
          - start
          - --mode=dev
          - --advertise-kafka-addr=redpanda:9092
      api:
        build: .
        ports:
          - "3000:3000"
        env_file:
          - .env
        volumes:
          - .:/usr/src/app
          - /usr/src/app/node_modules
        depends_on:
          - redpanda
    ```

2.  **Update Environment Variables**:
    Add the Redpanda broker address to `.env.example`.

    ```env
    # .env.example
    DOCKER_USERNAME=""
    DOCKER_PASSWORD=""
    REDPANDA_BROKER="redpanda:9092"
    ```

### Step 2: Install Dependencies

Add the `kafkajs` library to the project.

```bash
npm install kafkajs
```

### Step 3: Create Event Publisher Service

Create a new file `event-publisher.js` to manage the Kafka producer and abstract the event publishing logic.

*File: `event-publisher.js`*
```javascript
import { Kafka } from "kafkajs";

const kafka = new Kafka({
  clientId: "vps-api",
  brokers: [process.env.REDPANDA_BROKER],
});

const producer = kafka.producer();
let isConnected = false;

export async function connectProducer() {
  if (isConnected) return;
  await producer.connect();
  isConnected = true;
  console.log("Kafka Producer connected to Redpanda");
}

export async function disconnectProducer() {
  if (!isConnected) return;
  await producer.disconnect();
  isConnected = false;
  console.log("Kafka Producer disconnected");
}

export async function publishEvent(topic, event) {
  if (!isConnected) {
    await connectProducer();
  }
  await producer.send({
    topic,
    messages: [{ value: JSON.stringify(event) }],
  });
}
```

### Step 4: Integrate Event Publishing

Modify the existing application code to publish events at the following key points:

1.  **In `pwd-service.js` (`createPwdSession` function):**
    *   Publish `VPS_PROGRESS` events for `AUTHENTICATION_START`, `AUTHENTICATION_SUCCESS`, and `AUTHENTICATION_FAILURE`.
    *   Publish `VPS_ERROR` if any step fails.

2.  **In `routes/vps.js` (`POST /` route):**
    *   After `createPwdSession` succeeds, publish a `VPS_CREATED` event to the `vde.vps.lifecycle` topic using the returned session data.

3.  **In `routes/vps.js` (`DELETE /:id` route):**
    *   After `closeSession` succeeds, publish a `VPS_CLOSED` event to the `vde.vps.lifecycle` topic.

### Step 5: Handling Expired Sessions

To handle expired sessions, a background job is required. This is out of the scope of the initial implementation but should be considered for a future story. The job would:
1.  Periodically query the `sessions` table for entries where `expiresAt` is in the past.
2.  For each expired session, verify its status using `getSessionStatus`.
3.  If truly expired, publish a `VPS_EXPIRED` event to the `vde.vps.lifecycle` topic.
4.  Update the database record accordingly.

### Step 6: Example Consumer

For demonstration and testing, a simple consumer script can be created.

*File: `consumer.js`*
```javascript
import { Kafka } from "kafkajs";

const kafka = new Kafka({
  clientId: "vps-consumer",
  brokers: [process.env.REDPANDA_BROKER],
});

const consumer = kafka.consumer({ groupId: "dev-lab-test-group" });

const run = async () => {
  await consumer.connect();
  await consumer.subscribe({ topic: 'vde.vps.lifecycle', fromBeginning: true });
  await consumer.subscribe({ topic: 'vde.vps.progress', fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const event = JSON.parse(message.value.toString());
      console.log(`Received event from topic ${topic}:`, event);
    },
  });
};

run().catch(console.error);
```

## 5. Security

For production environments, the connection to Redpanda should be secured using SASL/TLS. This can be configured in the `kafkajs` client by providing the appropriate credentials and settings.

## 6. Benefits

*   **Decoupling:** Services can be developed, deployed, and scaled independently.
*   **Resilience:** The event broker acts as a buffer, allowing consumer services to process events at their own pace.
*   **Scalability:** Redpanda can handle a high volume of events, and new consumers can be added without impacting the producer.
*   **Observability:** The event stream provides a rich, real-time view of the system's activity.
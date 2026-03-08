# MVP: Google Cloud Shell Virtual Environment Orchestrator

This document outlines the Minimum Viable Product (MVP) to replace Play With Docker (PWD) with Google Cloud Shell (GCS) as the backend provider for the Virtual Development Environment Orchestrator.

## 1. Goal
Provide a robust, API-driven alternative to the fragile browser-automated PWD sessions. GCS offers pre-configured development environments with 5GB of persistent storage and a stable Google Cloud SDK for automation.

## 2. Core Architecture

The current architecture uses **Playwright** to simulate user interactions on `labs.play-with-docker.com`. The GCS-based MVP will replace this with the **Google Cloud Shell API**.

### 2.1. Component Mapping

| PWD Component | GCS Equivalent | Benefit |
| :--- | :--- | :--- |
| `pwd-service.js` (Playwright) | `gcs-service.js` (Google Cloud SDK) | Reliability & Speed |
| PWD Session ID | GCS Environment Name | Consistent Resource Identification |
| Public IP / SSH String | `gcloud cloud-shell ssh` | Secure, authenticated access |
| 4-hour limit | 12-hour session (Active) | Longer session duration |
| Ephemeral storage | 5GB Persistent Home Directory | Retain work across sessions |

## 3. Implementation Plan

### Phase 1: Google Cloud Integration
1.  **Enable Cloud Shell API**: Enable `cloudshell.googleapis.com` in the GCP Console.
2.  **Service Account Setup**: Create a Service Account with `roles/cloudshell.user` and `roles/cloudshell.viewer` permissions.
3.  **Authentication**: Configure the backend to use Application Default Credentials (ADC) or a Service Account JSON key.

### Phase 2: Core GCS Service (`gcs-service.js`)
Instead of `createPwdSession`, implement `startCloudShellSession`:
-   **Function**: `startCloudShellSession(userId)`
-   **Action**: Call `environments.start` via the Google Cloud Shell API.
-   **Data Collected**: `webHost` (for terminal access), `sshCommand`, and `environmentName`.

### Phase 3: Database & API Refactoring
1.  **Schema Update**: Update the `sessions` table in SQLite:
    -   `provider`: 'gcs'
    -   `envName`: GCS environment resource name.
    -   `sshCommand`: The `gcloud` command for connection.
2.  **Route Integration**: Update `POST /api/v1/sessions` to initialize the GCS environment and return its status (e.g., `STARTING`, `RUNNING`).

### Phase 4: Command Execution Layer
Replace the Playwright-based terminal automation with a Node.js-based SSH client (`ssh2`) that connects via the Google Cloud Shell SSH tunnel:
-   **Command**: `gcloud alpha cloud-shell ssh --command="..."`

## 4. MVP Feature Set
-   [ ] **Create Session**: Trigger a GCS environment startup.
-   [ ] **Get Details**: Retrieve the web terminal URL and `gcloud` SSH command.
-   [ ] **Check Status**: Query the API to see if the environment is ready.
-   [ ] **Stop Session**: Use `environments.removePublicKeys` or similar to "close" the session.
-   [ ] **Persistence**: Ensure files in `/home/user` persist between sessions.

## 5. Risks & Mitigation
-   **User-Account Constraint**: GCS is per-user. The MVP will require each user to authenticate via OAuth2 to manage *their* Cloud Shell, or the orchestrator must manage a pool of Google Accounts.
-   **GCP Quotas**: Cloud Shell is limited to 50 hours per week per user. The orchestrator should monitor and alert users of their usage.

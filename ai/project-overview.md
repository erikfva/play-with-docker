# Project Overview: PWD Virtual Environment Orchestrator

## 1. Objective

This project provides a micro-service that programmatically creates and manages Play with Docker (PWD) instances. The core of the project is a Node.js API that abstracts the complexity of interacting with the PWD website, offering a simple way to spin up temporary, VPS-like environments.

## 2. Core Technology Stack

-   **Backend:** Node.js, Express.js
-   **Browser Automation:** Playwright
-   **Database:** SQLite
-   **Containerization:** Docker, Docker Compose
-   **API Documentation:** Swagger (OpenAPI)

## 3. Project Status

The backend API development is complete. The service can:
-   Create new PWD sessions.
-   Store session details in a database.
-   Retrieve session information.
-   Check the status and remaining time of a session.
-   Execute commands within the session's web terminal.
-   Close sessions.

## 4. Setup and Configuration

### Environment Variables

The application requires Docker Hub credentials to be set in a `.env` file at the root of the project. Create a file named `.env` and add the following variables:

```
DOCKER_USERNAME=your_dockerhub_username
DOCKER_PASSWORD=your_dockerhub_password
```

### Running the Application

The application is containerized and managed with Docker Compose. To run the service, use the following command from the project root:

```bash
docker-compose up --build
```

This will build the Docker image and start the API service.

## 5. API Documentation and Endpoints

The API is documented using Swagger. Once the application is running, the interactive API documentation can be accessed at:

-   **Swagger UI:** [http://localhost:3000/api-docs](http://localhost:3000/api-docs)

### Key Endpoints:

-   `POST /api/v1/sessions`: Creates a new PWD session.
-   `GET /api/v1/sessions/{id}`: Retrieves session details from the database.
-   `GET /api/v1/sessions/pwd/{pwdSessionId}/timeleft`: Gets the remaining time for a session.
-   `GET /api/v1/sessions/pwd/{pwdSessionId}/status`: Checks if a session is still active.
-   `POST /api/v1/sessions/{id}/command`: Executes a shell command in the session's web terminal.
-   `DELETE /api/v1/sessions/{id}`: Closes an active session and removes it from the database.

## 6. Database

The application uses a simple SQLite database to persist session information.

-   **Database File:** `sessions.db` (created automatically in the project root)
-   **Schema (`sessions` table):**
    -   `id` (Primary Key)
    -   `pwdSessionId` (Unique ID from PWD)
    -   `sessionUrl`
    -   `publicIp`
    -   `sshString`
    -   `createdAt`
    -   `expiresAt`
    -   `diskUsage`

## 7. Risks and Constraints

-   **High Risk: UI Changes:** The entire solution is tightly coupled to the PWD website's front-end code. Any changes to HTML element IDs, class names, or the user flow will break the automation and require immediate maintenance.
-   **Performance:** Headless browsers are resource-intensive. High concurrent demand on the API could lead to significant CPU and memory usage on the server.
-   **Terms of Service:** This automated approach may violate the Play with Docker Terms of Service. The tool should be used responsibly and not for abusive purposes.
-   **PWD Limitations:** The 4-hour session limit is a hard constraint. The application can only create sessions; it cannot extend their lifecycle.

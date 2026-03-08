# Project Plan: PWD Virtual Environment Orchestrator

## 1. Project Objective

To build a micro-service that provides VPS-like by programmatically creating and managing Play with Docker (PWD) instances. The core of the project is a Node.js API that abstracts the complexity of interacting with PWD.

## 2. Problem Analysis

-   **Core Challenge:** Play with Docker provides a valuable, free service for Docker experimentation but lacks a public, documented API for programmatic session creation.
-   **User Need:** Developers need a quick, automated way to spin up fresh, temporary VPS without the manual process of visiting the website, logging in, and creating an instance.
-   **Technical Hurdle:** The only viable way to interact with the session creation process is by simulating a user's behavior in a web browser.

## 3. Proposed Solution

The chosen solution is to use a **headless browser automation** tool, **Playwright**, to perform the necessary actions on the PWD website. This approach, while potentially fragile, is the most feasible method given the absence of a formal API.

The backend will be a Node.js/Express application that exposes a single, simple endpoint. When this endpoint is called, the server will:
1.  Launch a headless instance of Chromium.
2.  Navigate to the PWD login page.
3.  Submit Docker Hub credentials (stored securely on the server).
4.  Create a new PWD instance.
5.  Scrape the session URL, IP address, and SSH string from the resulting page.
6.  Return this information as a JSON response.

## 4. Project Phases & Milestones

### Phase 1: Research & Discovery (Completed)

-   **Task:** Investigate the existence of a PWD API.
-   **Outcome:** Confirmed that no public API for session creation exists.
-   **Decision:** Proceed with a browser automation strategy.

### Phase 2: Backend API Development (In Progress)

-   **Milestone 1:** Containerize the application using Docker and Docker Compose.
-   **Milestone 2:** Implement the core Playwright service to handle login and session creation logic.
-   **Milestone 3:** Implement a SQLite database to store session information, including the unique PWD Session ID.
-   **Milestone 4:** Create the Express API endpoints (`POST /sessions`, `GET /sessions/:id`, and `GET /sessions/pwd/:pwdSessionId/timeleft`).
-   **Milestone 5:** Implement secure credential handling using an `.env` file with Docker Compose.
-   **Milestone 6:** Add robust error handling for automation and database failures.

### Phase 3: Frontend Integration (Future)

-   **Milestone 1:** Set up a basic React application.
-   **Milestone 2:** Create a UI component with a button to request a new sandbox.
-   **Milestone 3:** Implement the API call to the backend to create a session.
-   **Milestone 4:** Display the returned session information (URL, IP, SSH) to the user.
-   **Milestone 5:** Add a feature to easily copy the connection details.

### Phase 4: Testing & Deployment (Future)

-   **Milestone 1:** Write integration tests for the API endpoint.
-   **Milestone 2:** Deploy the containerized application to a cloud service.

## 5. Deliverables

-   A functional Node.js/Express backend API capable of creating PWD sessions.
-   Clear documentation (`README.md`) explaining setup, usage, and limitations.
-   A secure method for handling Docker Hub credentials.
-   A summary of PWD's constraints and the risks associated with this automation approach.

## 6. Risks & Constraints

-   **High Risk: UI Changes:** The entire solution is tightly coupled to the PWD website's front-end code. Any changes to HTML element IDs, class names, or the user flow will break the automation and require immediate maintenance.
-   **Performance:** Headless browsers are resource-intensive. High concurrent demand on the API could lead to significant CPU and memory usage on the server.
-   **Terms of Service:** This automated approach may violate the Play with Docker Terms of Service. The tool should be used responsibly and not for abusive purposes.
-   **Security:** While server-side credentials are secure, the API endpoint must be protected in a real-world scenario to prevent unauthorized users from creating PWD sessions using the server's resources.
-   **PWD Limitations:** The 2-hour session limit is a hard constraint. The application can only create sessions; it cannot extend or manage their lifecycle.

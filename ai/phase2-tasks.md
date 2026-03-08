# Phase 2 Tasks: Backend API Development

This document outlines the tasks required to complete the backend API development phase of the project.

## Milestone 1: Containerize the application

-   [x] Create a `Dockerfile` to define the application's environment.
-   [x] Create a `docker-compose.yml` file to manage the application and its services.

## Milestone 2: Implement the core Playwright service

-   [x] Create a `pwd-service.js` file to house the browser automation logic.
-   [x] Implement the `createPwdSession` function to handle login and session creation.

## Milestone 3: Implement a SQLite database

-   [x] Create a `db.js` file to manage the database connection.
-   [x] Implement a schema for the `sessions` table.
-   [x] Integrate the database with the `createPwdSession` function to store session information.

## Milestone 4: Create the Express API endpoints

-   [x] Create a `server.js` file to define the Express application.
-   [x] Implement the `POST /api/v1/sessions` endpoint.
-   [x] Implement the `GET /api/v1/sessions/:id` endpoint.
-   [x] Implement the `GET /api/v1/sessions/pwd/:pwdSessionId/timeleft` endpoint.
-   [x] Implement the `GET /api/v1/sessions/pwd/:pwdSessionId/status` endpoint.
-   [x] Implement the `DELETE /api/v1/sessions/:id` endpoint.
-   [x] Implement the `POST /api/v1/sessions/{id}/command` endpoint.

## Milestone 5: Implement secure credential handling

-   [x] Create a `.env.example` file to document the required environment variables.
-   [x] Use the `dotenv` package to load environment variables.
-   [x] Integrate the environment variables with the `createPwdSession` function.

## Milestone 6: Add robust error handling

-   [x] Implement `try...catch` blocks in all asynchronous functions.
-   [x] Provide meaningful error messages to the user.

## Milestone 7: Enhance session data

-   [x] Add a `diskUsage` field to the `sessions` table.
-   [x] Implement a function to run remote commands via SSH.

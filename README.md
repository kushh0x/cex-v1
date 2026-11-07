# CEX-v1 — Centralized Exchange

A simple **Centralized Exchange (CEX) backend** built from scratch using Bun, TypeScript, Express.js, PostgreSQL, and Prisma.

CEX-v1 implements the core functionality of a centralized exchange, including user authentication, wallet management, limit orders, an in-memory order book, and a matching engine to execute trades.

## Tech Stack

- **Runtime:** Bun
- **Framework:** Express.js
- **Language:** TypeScript
- **Database:** PostgreSQL (Neon)
- **ORM:** Prisma v7
- **Authentication:** JWT (HttpOnly Cookies)
- **Password Hashing:** Argon2

## Features

### 1. Authentication

- User signup and signin.
- Password hashing using Argon2.
- JWT-based authentication.
- HttpOnly cookies for token storage.

### 2. Wallet & Onramp

- Simulated INR deposits.
- User balances stored in PostgreSQL.
- Separate available and locked balances.
- Balance management during order placement and trade execution.

### 3. Order Management

- Supports limit BUY and SELL orders.
- Locks funds when an order is placed.
- Prevents users from using funds already committed to open orders.
- Supports order cancellation.
- Refunds remaining locked funds when an order is cancelled.

### 4. In-Memory Order Book

- Maintains separate BUY (bids) and SELL (asks) orders.
- Organizes orders by price priority.
- Highest BUY price gets priority.
- Lowest SELL price gets priority.
- Maintains the active order book in memory for fast access.

### 5. Matching Engine

- Matches BUY and SELL orders when their prices overlap.
- Supports full and partial order execution.
- Executes trades at the resting order's price.
- Records executed trades in the fills table.
- Updates buyer and seller balances.
- Handles locked funds during trade execution.
- Updates order statuses, including `OPEN`, `PARTIALLY_FILLED`, and `FILLED`.

## Architecture

CEX-v1 uses PostgreSQL for persistent data storage and an in-memory data structure for managing the order book.

| Component            | Responsibility                                             |
| -------------------- | ---------------------------------------------------------- |
| PostgreSQL           | Stores users, balances, stocks, orders, and trade records. |
| UserBalance Table    | Maintains available and locked user balances.              |
| In-Memory Order Book | Maintains active BUY and SELL orders for matching.         |
| Matching Engine      | Matches orders and processes trade execution.              |

**Note:** User balances are stored in PostgreSQL. An in-memory balance cache has not been implemented yet.

The order book currently exists only in memory. It is lost when the server restarts, while user balances and order records remain persisted in PostgreSQL.

## 📡 API Endpoints

| Method | Endpoint             | Description                   |
| ------ | -------------------- | ----------------------------- |
| POST   | `/signup`            | Register a new user           |
| POST   | `/signin`            | Authenticate a user           |
| POST   | `/onramp`            | Deposit simulated INR         |
| POST   | `/order`             | Place a BUY or SELL order     |
| GET    | `/balances`          | Get all user balances         |
| GET    | `/balance/inr`       | Get INR balance               |
| GET    | `/orders`            | Get user's orders             |
| GET    | `/order/:orderId`    | Get a specific order          |
| DELETE | `/order/:orderId`    | Cancel an order               |
| GET    | `/fills`             | Get user's executed trades    |
| GET    | `/orderbook/:symbol` | Get bids and asks for a stock |

## ⚙️ Getting Started

### Prerequisites

- [Bun](https://bun.com/)
- PostgreSQL database (or a Neon PostgreSQL instance)

### 1. Clone the Repository
```
git clone <repository-url>
cd cex-v1
```

### 2. Install Dependencies
```
bun install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root:
```
DIRECT_URL="your_postgresql_connection_string"
JWT_SECRET="your_jwt_secret"
```

### 4. Set Up the Database

Apply the existing Prisma migrations to your PostgreSQL database:
```bash
bunx prisma migrate deploy
```

Generate the Prisma Client:
```bash
bunx prisma generate
```
### 5. Start the Server
```
bun api.ts
```

The server runs on port `3000`.

## 🛠️ Development Commands

| Command       | Description            |
| ------------- | ---------------------- |
| `bun install` | Install dependencies   |
| `bun api.ts`  | Start the server       |
| `bun check`   | Type-check the project |
| `bun fmt`     | Format the code        |

## Limitations

- This is a simplified educational implementation of a centralized exchange.
- INR deposits are simulated; no real money or cryptocurrency transactions are involved.
- The order book is maintained in memory and is lost when the server restarts.
- Open orders stored in PostgreSQL are not automatically restored into the in-memory order book after a restart.
- Your balance updates and fill creation are separate Prisma queries. They aren't currently wrapped in a database transaction. Avoid claiming atomic trade execution in your README.



## Project Goal

The goal of CEX-v1 is to understand and implement the core backend concepts behind a centralized exchange, including wallet management, order books, order matching, and trade execution.

    
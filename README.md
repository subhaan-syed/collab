# Collab

A real-time collaborative code editor. Multiple users open the same document URL
and type simultaneously. Their edits merge conflict-free using a custom CRDT engine
built from scratch. Each user sees the other users' cursors and text selections live.
Documents survive server restarts.

---

## What is a CRDT and why was it needed

A CRDT, or Conflict-free Replicated Data Type, is a data structure designed so
that multiple independent copies of it can be updated concurrently and then merged
in any order without any coordination, with the same result every time. In a
classic text editor, if two users insert a character at position 5 at the same
time, a naive approach based on character offsets would produce different results
depending on which insert was processed first. One user's edit would overwrite or
shift the other's in a non-deterministic way. A CRDT solves this by replacing
mutable indices with stable, globally unique identifiers attached to each
character, and by defining a deterministic conflict-resolution rule that every
site applies identically.

For this project, the specific CRDT chosen is an RGA (Replicated Growable Array).
In an RGA every character carries a unique identifier: a pair of (siteId,
logicalClock). When two characters are inserted after the same anchor position
concurrently, the RGA uses a deterministic tie-break rule: the character whose
siteId is lexicographically greater is placed first (to the left). Because every
site evaluates this comparison against the same immutable identifiers, every site
reaches the same ordering regardless of the order in which it received the two
operations. Deletions are handled as tombstones: the node is marked deleted but
never removed from the list, so any concurrent insertion that references the
deleted character as its anchor still finds it.

Without a CRDT, real-time collaboration requires a central server to arbitrate
every change, or operational transformation (OT), which requires a complex
transformation matrix for every pair of operation types and is notoriously
difficult to implement correctly for anything beyond basic insert/delete. CRDTs
shift the complexity to the data structure itself, making the merge logic purely
local and peer-to-peer. The result is a system where the server is only needed for
fanout (forwarding operations) and persistence, not for conflict arbitration.

---

## Architecture

```
  Browser A                      Browser B
  ---------                      ---------
  React + CodeMirror             React + CodeMirror
  TypeScript RGA CRDT            TypeScript RGA CRDT
       |     ^                        |     ^
       |     |  WebSocket             |     |  WebSocket
       v     |                        v     |
  +-------------------------------------------+
  |           FastAPI (Python 3.11)           |
  |                                           |
  |  ConnectionManager (in-memory rooms)      |
  |  Python RGA CRDT (state reconstruction)   |
  |                                           |
  +--------+--------------------+-------------+
           |                    |
           v                    v
   +---------------+    +---------------+
   |  PostgreSQL   |    |   MongoDB     |
   |               |    |               |
   | documents     |    | documents     |
   | ops (JSONB)   |    | presence_     |
   |               |    | events        |
   +---------------+    +---------------+
```

On every keystroke the browser:
1. Generates a CRDT insert or delete operation with a unique (siteId, clock) id.
2. Applies it immediately to the local RGA document (optimistic local apply).
3. Sends it over WebSocket to the FastAPI server.

The server:
1. Validates and persists the operation to PostgreSQL.
2. Fans it out to every other browser in the same document room.

Each receiving browser:
1. Applies the remote operation to its own RGA document.
2. Translates the CRDT change into a CodeMirror document transaction.

Cursor and selection presence follow the same fan-out path but are never persisted
to the database. They are ephemeral and forwarded directly to other clients.

On server restart, the FastAPI backend replays the full ops log from PostgreSQL
through the Python RGA implementation to reconstruct the document text.
MongoDB stores document metadata and session history (join/leave times) for
analytics. It is not in the critical read path.

---

## How the CRDT works: step-by-step example

Consider two users, Alice (siteId = "alice") and Bob (siteId = "bob"), editing
a blank document simultaneously.

**Step 1 — Both users insert the first character.**

Alice types "A" and Bob types "B", both after the sentinel head (position 0). The
two operations are:

    Op-A: { type: "insert", charId: {siteId:"alice", clock:1}, value:"A", afterId: null }
    Op-B: { type: "insert", charId: {siteId:"bob",   clock:1}, value:"B", afterId: null }

Both operations are generated locally and sent to the server before either user
has seen the other's op.

**Step 2 — Conflict resolution at each site.**

Alice receives Op-B. She needs to insert Bob's "B" after the sentinel, but her
own "A" is already there. The RGA conflict-resolution scan checks: does "A" share
the same originAfterId (null) as "B"? Yes. Is Bob's siteId ("bob") greater than
Alice's ("alice")? Yes. So "B" is placed before "A". Alice's document becomes
"BA".

Bob receives Op-A. He already has "B" at position 0. The scan checks: is "B" a
sibling of "A" (same afterId)? Yes. Is "alice" greater than "bob"? No. So "A" is
placed after "B". Bob's document also becomes "BA".

**Step 3 — Both sites have converged.**

Alice sees "BA". Bob sees "BA". The documents are identical even though neither
user's client was coordinated with the other. The outcome was determined entirely
by the deterministic siteId comparison, not by the order of message delivery.

**Step 4 — Deletion is safe regardless of order.**

If Alice now deletes "A" (Op-D: { type:"delete", charId:{siteId:"alice", clock:1} }),
this operation can arrive at Bob before or after any future insertions that
reference "A" as their anchor. The tombstone model ensures the node stays in the
list and is invisible in the rendered text, but future inserts that reference it
as their anchor are still placed correctly relative to surrounding characters.

---

## Setup

### With Docker (recommended)

Requires Docker and Docker Compose.

```bash
git clone https://github.com/subhaan-syed/collab.git
cd collab

# Copy and review the environment file (defaults work out of the box)
cp .env.example .env

# Build and start all services (FastAPI, PostgreSQL, MongoDB)
docker-compose up --build
```

The API is now available at http://localhost:8000.

Start the frontend dev server in a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

### Without Docker (local development)

Requirements: Python 3.11+, Node.js 18+, PostgreSQL 15, MongoDB 6.

```bash
git clone https://github.com/subhaan-syed/collab.git
cd collab

# Apply the database schema
psql -U <your_user> -d collab -f init.sql

# Install backend dependencies and configure environment
cd backend
pip install -r requirements.txt
cp ../.env.example .env
# Edit .env to point to your local database instances

# Start the FastAPI server
uvicorn app.main:app --reload --port 8000

# In a new terminal, install and start the frontend
cd ../frontend
npm install
npm run dev
```

---

## Running tests

### CRDT unit tests (Jest)

```bash
cd frontend
npm test
```

Expected output: 46 tests passing across 5 test suites.

### Backend tests (pytest)

```bash
cd backend
pytest -v
```

Expected output: 22 tests passing.

### End-to-end tests (Playwright)

Requires both the backend and the frontend dev server to be running.

```bash
# Terminal 1
docker-compose up   # or: uvicorn app.main:app --port 8000

# Terminal 2
cd frontend && npm run dev

# Terminal 3
cd frontend
npx playwright install chromium   # first time only
npx playwright test
```

---

## Project structure

```
collab/
├── docker-compose.yml      One-command startup for all services
├── init.sql                PostgreSQL schema
├── .env.example            Environment variable template
├── backend/
│   ├── app/
│   │   ├── main.py         FastAPI app entry point
│   │   ├── config.py       Settings (pydantic-settings)
│   │   ├── database.py     asyncpg pool + Motor client
│   │   ├── crdt.py         Python RGA implementation
│   │   ├── ws_manager.py   WebSocket room manager
│   │   ├── models.py       Pydantic wire models
│   │   └── routers/
│   │       ├── documents.py  REST API
│   │       └── websocket.py  WS endpoint
│   └── tests/
│       ├── test_crdt.py    Python RGA unit tests
│       └── test_api.py     REST endpoint integration tests
└── frontend/
    ├── src/
    │   ├── crdt/rga.ts         TypeScript RGA implementation
    │   ├── hooks/
    │   │   ├── useWebSocket.ts
    │   │   └── useCollabEditor.ts
    │   ├── components/
    │   │   ├── HomePage/
    │   │   └── Editor/
    │   ├── styles/             SCSS design system
    │   └── types/index.ts
    └── tests/
        ├── unit/crdt.test.ts   18 RGA unit tests
        ├── components/         28 RTL component tests
        └── e2e/collab.spec.ts  5 Playwright tests
```

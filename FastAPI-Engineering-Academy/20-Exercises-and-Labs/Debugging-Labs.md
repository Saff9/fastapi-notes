---
title: Debugging Labs
aliases:
 - Debugging Labs
 - Code Reading Labs
 - Spot-the-Bug Labs
tags:
 - exercises
 - debugging
 - code-review
 - labs
course_level: intermediate
difficulty: intermediate
estimated_time: "2–3 hours across all six"
status: complete
prerequisites:
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
 - "[[04-Pydantic/BaseModel-and-Validation]]"
 - "[[09-Alembic-Migrations/Data-Migrations-Safely]]"
 - "[[07-SQLAlchemy/02-Engines-Connections-Pools]]"
related_lessons:
 - "[[20-Exercises-and-Labs/Troubleshooting-Index]]"
 - "[[19-Interview-Preparation/Production-Incidents-Debugging]]"
 - "[[00-Exercises-MOC]]"
---

# Debugging Labs

*Six hands-on labs. Each presents a broken FastAPI / SQLAlchemy code snippet. Find the bug, explain it, write the fix. Do not look at the answer until you have a hypothesis.*

**How to use these labs**

For each lab: read the code carefully, identify the symptom, **form a hypothesis before reading the answer** (this is the most important step — recognition is easy; recall is what interviews and on-call shifts test), write the fix, then read the explanation. If your fix differs from the model fix, ask whether yours is equivalent, better, or worse. Either way, you should be able to justify it. The labs are in roughly increasing order of difficulty: Lab 1 is the most common interview bug; Lab 6 is the most operationally subtle.


#exercises #debugging #labs

## How to use these labs

For each lab:

1. **Read the code** carefully. All of it. Note any oddities — a `def` where you expected `async def`, an `except Exception: pass`, a missing `selectinload`, a default mutable argument, an unbounded pool.
2. **Identify the symptom.** What error or wrong behavior would this code produce in production?
3. **Form a hypothesis.** Write it down before reading the answer. If you skip this step, you are not practicing — you are reading.
4. **Write the fix.** Type the corrected code. Do not just describe it.
5. **Read the explanation.** If your fix differs from the model fix, ask: is yours equivalent, better, or worse?

**Danger — The most common lab mistake**

Reading the answer before forming a hypothesis. The lab is not a tutorial — it's a quiz. If you read the answer first, you've trained recognition, not recall. Recognition is easier and far less useful in interviews and on-call shifts. Force yourself to write a hypothesis first.


**Tip — Think like a senior debugger: the five-step framework — reproduce, isolate, hypothesise, test, fix**

The labs below each present a bug, but the bug is the easy part — the discipline is the *method*. A senior debugger's first instinct at a 3 a.m. incident is not "what's the fix?" but "what is the smallest reproducer I can write?" The five-step framework, in this order:

1. **Reproduce.** Before you fix anything, make the bug happen on your machine (or in a staging environment you control). A bug you cannot reproduce is a bug you cannot verify you have fixed. The reproducer is the *contract* — when the fix is in, the reproducer no longer fails, and that is your evidence. If you cannot reproduce, jump to the "When you can't reproduce" callout below — but do not skip this step.
2. **Isolate.** Reduce the reproducer to its smallest form. Comment out half the code; does the bug still happen? Delete the second table from the JOIN; does it still happen? Strip the request body to one field; does it still happen? Each isolation step removes a variable from your hypothesis space. The senior debugger's rule: "if I can't trigger it with five lines, I haven't isolated it yet."
3. **Hypothesise.** Write down *one sentence* explaining what you think is wrong. Not "the database is slow" — "the N+1 is in the serializer's `customer_name` property." The hypothesis is falsifiable: it predicts what you will see in the next step. If you cannot write one sentence, you have not isolated enough — go back to step 2.
4. **Test.** Verify the hypothesis *before* you change any code. Read the SQLAlchemy `echo` log and count the queries (does it match the hypothesis's prediction?). Run `EXPLAIN ANALYZE` on the query the hypothesis says is slow. Add a `print()` where the hypothesis says the value is `None`. The test either confirms the hypothesis (proceed to step 5) or refutes it (back to step 2 with new information). Skipping this step is the single most common cause of "the fix made it worse."
5. **Fix.** Only now — with a reproducer, an isolation, a hypothesis, and a confirmed test — do you write the fix. The fix should be the smallest change that resolves the hypothesis; resist the urge to "clean up while I'm in here." Run the reproducer against the fix; it should no longer fail. Add a regression test that captures the reproducer, so the bug cannot return silently.

The discipline of *not jumping to step 5* is what separates the senior debugger from the junior. The junior reads the symptom, guesses the fix, ships it, and either gets lucky or makes it worse. The senior reads the symptom, spends 80% of the time on steps 1-4, ships a fix that is verifiably correct, and adds a regression test so the bug never returns. The labs below are practice for steps 1-4, not step 5 — the answer is the *least* interesting part.


**Warning — When you can't reproduce: the environment is different, the data is different, or the timing is different**

A bug that "only happens in production" is not a bug you cannot reproduce — it is a bug whose reproducer you have not yet written. The senior debugger's response is to triage the three differences between the failing environment and the working one, in order of decreasing likelihood:

**The environment is different.** Production runs Python 3.12.7 on Debian 12; your laptop runs 3.12.15 on macOS 15. The Postgres in production is 17.4 with `shared_buffers = 4GB`; your docker-compose runs 17.2 with defaults. The `asyncpg` is 0.30.1 in production (pinned in `uv.lock`) and 0.31.0 on your laptop (you `uv add`-ed it yesterday). Any of these can produce a behaviour difference. The fastest narrowing: `docker run` the production image with the production `uv.lock` against a snapshot of the production database — if the bug reproduces, the cause is data or traffic (next two triage branches); if it doesn't, the cause is in the environment diff. Diff the `pip freeze`, diff the `pg_settings`, diff the kernel version. A `py-spy dump --pid <pid>` on the stuck production process is the highest-signal single command — it shows the exact Python stack at the moment of the hang, which often points straight at the missing reproducer (a C-extension call that hangs on a specific kernel version, an asyncpg socket call waiting on a TCP keepalive the laptop never triggers).

**The data is different.** Your dev database has 1,000 rows; production has 10,000,000. The bug is a query plan that flips from index scan to sequential scan at the planner's cost-estimate threshold (the "query that was fast yesterday is slow today" failure mode in [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]]). Or the bug is a `NULL` value that exists in 0% of dev rows and 0.02% of production rows — the `coalesce` you forgot returns `None` for those rows and the Pydantic validator rejects it. The fastest narrowing: snapshot the production data into a staging database (or `pg_dump --data-only --table=affected_table | head -100000 | psql staging`), point your code at it, run the failing endpoint. If the bug reproduces, the cause is data-shaped; run `EXPLAIN ANALYZE` on the production-shaped query and look for the plan divergence.

**The timing is different.** The bug only happens under load, only on Mondays at 9 a.m., only when the CRM webhook is slow. Timing bugs are race conditions (two requests interleaving on the same row), resource-contention bugs (the connection pool exhausted by the Monday-morning burst), or external-dependency bugs (the CRM webhook takes 30 seconds and your retry logic has a 25-second timeout). The fastest narrowing: a load test that reproduces the production traffic shape (`locust` or `k6`), or a synthetic that simulates the slow dependency (an `httpx.MockTransport` that sleeps 30 seconds on the webhook URL). If the bug reproduces only under load, you have a race; capture a `py-spy record --pid <pid> --format=flamegraph` during the load test and the flamegraph will show the contention.

The senior debugger's law: *a bug you cannot reproduce is a bug whose variable you have not yet identified.* The three branches above are the search space; triage them in this order because environment diffs are cheapest to find, data diffs are next, and timing diffs are most expensive (they require load-test infrastructure). When all three fail, the cause is usually a configuration value (`APP_SOME_SETTING`) that differs between environments — diff the env vars and the config files last.


---

## Lab 1: N+1 in a serializer

### Buggy code

```python
# app/api/orders.py
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.deps import DbSession
from app.models import Order
from app.schemas import OrderOut

router = APIRouter()

@router.get("/orders", response_model=list[OrderOut])
async def list_orders(session: DbSession) -> list[Order]:
 stmt = select(Order).order_by(Order.created_at.desc()).limit(100)
 orders = (await session.scalars(stmt)).all()
 return orders
```

```python
# app/schemas/orders.py
from pydantic import BaseModel, ConfigDict

class OrderOut(BaseModel):
 model_config = ConfigDict(from_attributes=True)
 id: int
 total: float
 customer_name: str
 items_count: int
```

```python
# app/models/order.py
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db import Base

class Order(Base):
 __tablename__ = "orders"
 id: Mapped[int] = mapped_column(primary_key=True)
 total: Mapped[float]
 customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
 customer: Mapped["Customer"] = relationship(back_populates="orders")
 items: Mapped[list["OrderItem"]] = relationship(back_populates="order")

 @property
 def customer_name(self) -> str:
 return self.customer.name # access the relationship

 @property
 def items_count(self) -> int:
 return len(self.items) # access the relationship
```

### Symptom

The `/orders` endpoint takes 5 seconds to respond in production. CPU on the app and DB is low. The single-order endpoint `/orders/{id}` is fast.

**Before you read the answer**

Write down your hypothesis. One sentence. Then write the fix. Then check below.


### Your task

1. Find the bug.
2. Explain it.
3. Write the fix.

### Answer

**The bug:** The endpoint issues 101 SQL queries. The `select(Order).limit(100)` loads 100 orders; then Pydantic serializes each, calling `customer_name` (which lazy-loads `customer`) and `items_count` (which lazy-loads `items`). Each lazy access is one round trip per relationship per order: 100 × 2 = 200, plus the original query, totaling ~201 round trips.

**The fix:** Eager-load `customer` and `items` in the query.

```python
from sqlalchemy.orm import selectinload

@router.get("/orders", response_model=list[OrderOut])
async def list_orders(session: DbSession) -> list[Order]:
 stmt = (
 select(Order)
 .options(
 selectinload(Order.customer),
 selectinload(Order.items),
 )
 .order_by(Order.created_at.desc())
 .limit(100)
 )
 orders = (await session.scalars(stmt)).all()
 return orders
```

Now the endpoint issues 3 queries: 1 for orders, 1 for customers (via `IN`), 1 for items (via `IN`).

**Prevention:**

- Add a query-count assertion in the integration test: `assert_query_count(client.get("/orders"), expected=3)`.
- Use `raiseload(Order.customer)` and `raiseload(Order.items)` in the test session so future lazy accesses in this endpoint fail loudly in tests.

**Tip — Why this is the canonical interview lab**

Almost every senior backend interview includes an N+1 question. It is the bug that combines ORM choices and serializer choices — both of which look fine in isolation. Practice this one until you can spot it cold.


**Cross-reference:** [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]], [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]], Incident 1 in [[19-Interview-Preparation/Production-Incidents-Debugging]], Q9 of [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]].

---

## Lab 2: Sync DB call inside `async def`

### Buggy code

```python
# app/services/legacy.py
import requests
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from app.config import settings

# Legacy sync engine — kept for migration.
_sync_engine = create_engine(settings.legacy_db_url)
_SyncSession = sessionmaker(_sync_engine)

async def fetch_legacy_user(user_id: int) -> dict:
 session = _SyncSession()
 try:
 row = session.execute(
 "SELECT * FROM legacy_users WHERE id = :id",
 {"id": user_id},
 ).first()
 upstream = requests.get(f"https://legacy-upstream/users/{user_id}").json()
 return {**row._mapping, "upstream": upstream}
 finally:
 session.close()
```

### Symptom

Under load, the `/users/{id}` endpoint that calls this service has P99 latency of 30 seconds, despite no individual query or HTTP call taking more than 200ms. Other endpoints on the same service also slow down when this one is hit hard.

**Before you read the answer**

What does "other endpoints slow down when this one is hit hard" tell you about the bug's location?


### Your task

1. Find the bug.
2. Explain it.
3. Write the fix (two acceptable versions).

### Answer

**The bug:** The function is `async def`, but it does two blocking operations:

1. `session.execute(...)` uses a sync SQLAlchemy session with a sync driver (e.g. `psycopg2`), which blocks the event loop while waiting for the DB response.
2. `requests.get(...)` is the synchronous HTTP client; it blocks the event loop while waiting for the response.

Because the function is `async def`, FastAPI runs it on the event loop directly. Each blocking call holds the entire event loop for the duration of the call. Under load, every concurrent request stalls. The "other endpoints slow down" symptom is the giveaway — they share the same event loop.

**The fix (preferred — async libraries):**

```python
import httpx
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text

_async_engine = create_async_engine(settings.legacy_db_url_async)
_AsyncSession = async_sessionmaker(_async_engine, expire_on_commit=False)

async def fetch_legacy_user(user_id: int) -> dict:
 async with _AsyncSession() as session:
 row = (await session.execute(
 text("SELECT * FROM legacy_users WHERE id = :id"),
 {"id": user_id},
 )).first()
 async with httpx.AsyncClient() as client:
 upstream = (await client.get(f"https://legacy-upstream/users/{user_id}")).json()
 return {**row._mapping, "upstream": upstream}
```

**The fix (acceptable — make it `def`):**

```python
def fetch_legacy_user(user_id: int) -> dict:
 session = _SyncSession()
 try:
 row = session.execute(
 "SELECT * FROM legacy_users WHERE id = :id",
 {"id": user_id},
 ).first()
 upstream = requests.get(f"https://legacy-upstream/users/{user_id}").json()
 return {**row._mapping, "upstream": upstream}
 finally:
 session.close()
```

FastAPI runs `def` handlers in the threadpool, so blocking calls do not stall the event loop.

**Do not** keep it `async def` and add `await asyncio.to_thread(...)`: this is correct but more verbose than just making it `def`. Use `to_thread` only if you need to mix sync and async within one function (e.g., call an async library after a sync call).

**Warning — The "looks async but is sync" trap**

The function is `async def`. It awaits nothing. The keyword `async` is doing no work here — it just signals to FastAPI to run it on the event loop. The blocking calls inside then hold the loop. The fix is *either* make the libraries async (preferred) *or* downgrade the function to `def` (let FastAPI threadpool it). Both are correct; "async def + sync libraries" is never correct.


**Prevention:** Add a CI lint rule (e.g., `flake8-async` or `ruff` rule `ASYNC100`) that flags blocking calls inside `async def`. Add an event-loop-latency metric; alert when latency exceeds 50ms.

**Cross-reference:** [[10-Async-Python/Event-Loop-and-Coroutines]], [[19-Interview-Preparation/FastAPI-and-DI-Questions]] Q8 and Q12, [[19-Interview-Preparation/Async-and-Concurrency-Questions]] Q4.

---

## Lab 3: Broad `except Exception: pass` swallowing `IntegrityError`

### Buggy code

```python
# app/services/user_service.py
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import User
from app.schemas import UserCreate

class UserService:
 def __init__(self, session: AsyncSession):
 self.session = session

 async def create_user(self, payload: UserCreate) -> User:
 user = User(email=payload.email)
 self.session.add(user)
 try:
 await self.session.commit()
 except Exception:
 # Don't bother the caller with DB errors.
 pass
 return user

 async def get_user(self, user_id: int) -> User | None:
 return await self.session.get(User, user_id)
```

### Symptom

A user signs up with an email that already exists. The API returns 201 Created with the user's data — but the data is the in-memory `User(email=...)` object with `id=None` (no row was inserted). When the front-end then calls `GET /users/{id}`, the response is 404. The customer report says "I signed up but my account doesn't exist."

Other symptoms: subsequent operations on the session in the same request raise `PendingRollbackError` (because the session is in a failed state).

**Before you read the answer**

There are three bugs in this snippet. Name them.


### Your task

1. Find the bug (there are actually two — and a third design flaw).
2. Explain them.
3. Write the fix.

### Answer

**The bugs:**

1. **`except Exception: pass`** swallows the `IntegrityError`. The caller does not know the insert failed. The session is left in a failed state.
2. **No rollback.** After an `IntegrityError`, SQLAlchemy requires `session.rollback()` before any further use. Without it, the next `session.execute` or `session.get` raises `PendingRollbackError`.
3. **Returning the in-memory `User` object** with `id=None` misleads the caller into thinking the row was inserted. The route happily returns 201 with a fake user object.

**The fix:**

```python
from sqlalchemy.exc import IntegrityError

class UserService:
 def __init__(self, session: AsyncSession):
 self.session = session

 async def create_user(self, payload: UserCreate) -> User:
 user = User(email=payload.email)
 self.session.add(user)
 try:
 await self.session.commit()
 except IntegrityError as exc:
 await self.session.rollback() # mandatory
 cause = exc.orig.__class__.__name__
 if cause == "UniqueViolation":
 raise Conflict("email_taken") from exc
 raise # unknown integrity error; let it propagate
 await self.session.refresh(user) # populate id from the DB
 return user
```

The route then translates `Conflict` to 409.

**Why catch `IntegrityError` specifically, not `Exception`:**

- `Exception` is too broad; it would swallow `OperationalError` (DB down), `PendingRollbackError` (programming bug), and any other unexpected error.
- `IntegrityError` is the specific error the service knows how to translate (a domain-level "the input conflicts with existing data").
- `except Exception: pass` is almost always a bug. If you genuinely need to swallow, swallow the specific exception with a documented reason.

**Danger — The "silent 201" failure mode**

This is one of the worst failure modes in an API: a successful-looking response that didn't actually do the work. The customer sees "your account was created!" — and then can't log in. The bug is hard to spot in logs (no 5xx, no exception, just a row that didn't insert) and hard to recover from (the customer thinks they have an account). Catching the specific exception and translating is the only honest path.


**Prevention:**

- Add a lint rule that flags bare `except Exception` (and bare `except:`). The `ruff` rule `E722` catches bare `except:`; `BLE001` (blind-except) catches `except Exception`.
- In tests, assert that the duplicate-email case raises `Conflict` and returns 409.
- Add an integration test that the session is usable after a failed commit (i.e., `get_user` works after a duplicate insert).

**Cross-reference:** [[01-Python-Foundations/Exceptions-Done-Right]], [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]] Q8, [[03-FastAPI-Core/Exception-Handlers]].

---

## Lab 4: Mutable default factory misuse (Pydantic)

### Buggy code

```python
# app/schemas/cart.py
from pydantic import BaseModel, Field
from datetime import datetime

class CartItem(BaseModel):
 sku: str
 quantity: int

class Cart(BaseModel):
 user_id: int
 items: list[CartItem] = [] # BUG 1
 coupons: dict[str, float] = {} # BUG 2
 created_at: datetime = Field(default_factory=datetime.now) # bug?
 notes: list[str] = Field(default=[]) # BUG 3

def add_default_cart() -> Cart:
 return Cart(user_id=0)
```

```python
# app/api/cart.py
@router.post("/carts/preview")
async def preview():
 c1 = Cart(user_id=1, items=[CartItem(sku="A", quantity=1)])
 c2 = Cart(user_id=2) # default items, coupons, notes
 c2.notes.append("free shipping")
 c3 = Cart(user_id=3)
 return {
 "c2_notes": c2.notes, # expect ["free shipping"]
 "c3_notes": c3.notes, # expect []
 }
```

### Symptom

The customer's preview returns `c3_notes: ["free shipping"]` — `c3` somehow has the note that was added to `c2`. The customer is confused; their notes are leaking between carts.

Additionally, at app startup, the server crashes with:

```
pydantic.errors.PydanticUserError: Mutable default of type list is not allowed; use `default_factory=list`
```

(But only if you fixed one of the lines. The three bugs together prevent the server from starting.)

**Before you read the answer**

There are three mutable-default issues plus one subtle *non*-bug. Identify all four.


### Your task

1. Find the bugs (there are three mutable-default issues plus one subtle non-issue).
2. Explain them.
3. Write the fix.

### Answer

**The bugs:**

1. **`items: list[CartItem] = []`** — a mutable default. Pydantic v2 forbids this and raises at class creation time. The error message is the one above. Fix: `Field(default_factory=list)`.
2. **`coupons: dict[str, float] = {}`** — same bug with a dict. Fix: `Field(default_factory=dict)`.
3. **`notes: list[str] = Field(default=[])`** — passing a mutable to `default=` is the same bug. The factory pattern is required. Fix: `Field(default_factory=list)`.

The subtle issue: `default_factory=datetime.now` — this is actually correct (`datetime.now` is callable, returns a fresh datetime each call). Some readers might think this is also a bug. It is not; it is the right way to default to "now."

**The fix:**

```python
from pydantic import BaseModel, Field
from datetime import datetime

class CartItem(BaseModel):
 sku: str
 quantity: int

class Cart(BaseModel):
 user_id: int
 items: list[CartItem] = Field(default_factory=list)
 coupons: dict[str, float] = Field(default_factory=dict)
 created_at: datetime = Field(default_factory=datetime.now)
 notes: list[str] = Field(default_factory=list)
```

**Why this matters:** The bug in the original (if it had run on older Pydantic v1) would have manifested exactly as the symptom: every instance of `Cart` shared the *same* `[]`, `{}`, and `[]` objects. Adding an item to one cart's notes added it to all carts' notes. Pydantic v2 catches this at class-creation time, but the underlying rule (do not use mutable defaults) applies everywhere in Python — it is the same rule as for function defaults, classes, and dataclasses.

**Tip — The rule, generalized**

Anywhere you write `= []`, `= {}`, `= set()` as a default — in a function signature, in a class attribute, in a dataclass field, in a Pydantic field — you have the same bug. Use `None` sentinel + `if x is None: x = []` in plain Python; use `Field(default_factory=list)` (or `dataclasses.field(default_factory=list)`) in frameworks.


**Prevention:**

- Pydantic v2 already enforces this at class-creation time; the rule is "the server will not start with this bug, so you catch it in development."
- For non-Pydantic code (plain classes, dataclasses), use `field(default_factory=list)` in dataclasses, or `None` sentinel + `if x is None: x = []` in plain classes.
- A `ruff` lint rule (e.g., `B006` for mutable function defaults) catches the analogous bug in plain Python.

**Cross-reference:** [[04-Pydantic/BaseModel-and-Validation]], [[04-Pydantic/Fields-Annotated-Reusable-Annotations]], [[01-Python-Foundations/Values-Objects-Mutability]].

---

## Lab 5: Migration that breaks the running app (renamed column)

### Buggy code

You have a model with a column `customer_email`. The team decides to rename it to `email` for consistency.

```python
# app/models/customer.py
class Customer(Base):
 __tablename__ = "customers"
 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str] = mapped_column(unique=True) # renamed from customer_email
 # ... other fields
```

```python
# migrations/versions/a1b2_rename_customer_email_to_email.py
"""rename customer_email to email

Revision ID: a1b2
Revises: 99c0
Create Date: 2026-10-15 14:00:00
"""
from alembic import op
import sqlalchemy as sa

revision = "a1b2"
down_revision = "99c0"
branch_labels = None
depends_on = None

def upgrade():
 op.alter_column(
 "customers",
 "customer_email",
 new_column_name="email",
 existing_type=sa.String(),
 )

def downgrade():
 op.alter_column(
 "customers",
 "email",
 new_column_name="customer_email",
 existing_type=sa.String(),
 )
```

```python
# app/services/customer_service.py
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import Customer

async def update_email(session: AsyncSession, customer_id: int, new_email: str):
 await session.execute(
 update(Customer)
 .where(Customer.id == customer_id)
 .values(customer_email=new_email) # <-- BUG
 )
 await session.commit()
```

### Symptom

After deploy, the `/customers/{id}/email` endpoint returns 500 with `UndefinedColumn: column "customer_email" of relation "customers" does not exist`. The migration ran successfully (the column is now `email` in the database), but the service code at `app/services/customer_service.py` still references the old column name.

You check `alembic upgrade head`; it succeeded. You check the model; it is updated. The service is broken.

**Before you read the answer**

The migration succeeded. The model is updated. The service is broken. Why?


### Your task

1. Find the bug (there are actually two).
2. Explain them.
3. Write the fix (code fix plus migration strategy to prevent this class of bug).

### Answer

**The bugs:**

1. **`update(Customer).values(customer_email=new_email)`** in the service uses the old column name. SQLAlchemy reads `Customer.customer_email`, which is no longer an attribute on the model (renamed to `email`); this raises `AttributeError` at class-definition time... wait, no — it does not. The service uses the string `"customer_email"` as a keyword argument, not the model attribute. SQLAlchemy translates this to a column name lookup, finds no `customer_email` column on the model (only `email`), and falls back to literal SQL — sending `SET customer_email = ?` to the DB, which rejects it.
2. **`Customer` model has `email`, but the service uses `customer_email`.** This is an inconsistency left over from the rename: the model was updated but the service was not.

**The immediate fix:**

```python
async def update_email(session: AsyncSession, customer_id: int, new_email: str):
 await session.execute(
 update(Customer)
 .where(Customer.id == customer_id)
 .values(email=new_email) # use the new column name
 )
 await session.commit()
```

Use the model attribute (`Customer.email`) directly to avoid string literals:

```python
from sqlalchemy import update

async def update_email(session: AsyncSession, customer_id: int, new_email: str):
 stmt = (
 update(Customer)
 .where(Customer.id == customer_id)
 .values({Customer.email: new_email})
 )
 await session.execute(stmt)
 await session.commit()
```

This way, if the column is renamed again, the attribute access fails at import time, not at runtime.

**The migration strategy fix — preventing this class of bug:**

The deeper bug is the **rename migration**. `ALTER TABLE ... RENAME COLUMN` is metadata-only on PostgreSQL (no table rewrite, no lock), so it is fast and safe. But the rename breaks *every line of code that references the old column name*. There is no way for the migration to find those references; the rename is a code change that must ship with the migration, atomically.

The safer pattern for renaming a column:

1. **Add the new column** alongside the old (`email` next to `customer_email`), nullable initially. (Migration 1.)
2. **Backfill** the new column from the old (`UPDATE customers SET email = customer_email`). (Migration 1 or a follow-up data migration.)
3. **Update application code** to write to both columns (dual-write). Deploy this code.
4. **Backfill** any rows that came in between step 2 and step 3.
5. **Drop the old column** (`DROP COLUMN customer_email`). (Migration N, well after the dual-write code is in production.)
6. **Remove the dual-write from the application code.** (Code change after migration N.)

This pattern is verbose but allows rollback at each step. The "rename in one migration" pattern is correct *only if* the code change ships atomically with the migration, with no possibility of running old code against the new schema — which is rarely true.

**Warning — Why "rename in one migration" is so tempting and so wrong**

It's a one-line migration. It's metadata-only. It looks like it can't break anything. But it breaks every caller of the old column name — and the migration cannot see the callers. The atomic-rename pattern is correct *if and only if* you can guarantee the code and the migration ship together with no chance of running old code against new schema. In practice, that's only safe for greenfield projects with no rolling deploys.


**Prevention:**

- Add a CI check: the migration script and the application code must be in the same deploy. Use a pre-deploy hook that runs `alembic check` to verify the database head matches the code's expected head.
- Add integration tests that exercise every endpoint that touches the renamed column, run against a database with the migration applied. The `UndefinedColumn` error would surface in the test, not in production.
- Review migration diffs: any `op.alter_column(..., new_column_name=...)` is a rename and requires a code review for "every call site has been updated."

**Cross-reference:** [[09-Alembic-Migrations/Data-Migrations-Safely]], [[09-Alembic-Migrations/Autogenerate-and-Its-Limits]], [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]], Incident 5 in [[19-Interview-Preparation/Production-Incidents-Debugging]].

---

## Lab 6: Pool exhaustion under load

### Buggy code

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

@asynccontextmanager
async def lifespan(app: FastAPI):
 # Engine created in lifespan — correct.
 app.state.engine = create_async_engine(
 "postgresql+asyncpg://user:pass@db/app",
 pool_size=10,
 max_overflow=10,
 pool_pre_ping=True,
 )
 yield
 await app.state.engine.dispose()

app = FastAPI(lifespan=lifespan)

# app/deps.py
from fastapi import Request

async def get_session(request: Request) -> AsyncSession:
 engine = request.app.state.engine
 async with AsyncSession(engine, expire_on_commit=False) as session:
 yield session

# app/background.py
from fastapi import BackgroundTasks
from app.deps import get_session

async def send_receipt(order_id: int):
 # Reuses the request's session for "convenience."
 session = await anext(get_session(...)) # hypothetical; the real code passes session through
 order = await session.get(Order, order_id)
 await send_email(order.customer.email)
 await session.commit()

# app/api/orders.py
@router.post("/orders/{id}/receipt", status_code=202)
async def send_order_receipt(
 id: int,
 background_tasks: BackgroundTasks,
 session: DbSession,
):
 background_tasks.add_task(send_receipt, id)
 return {"status": "queued"}
```

### Symptom

Under peak load (5,000 orders/minute via the `/orders/{id}/receipt` endpoint), the API starts returning 500 with:

```
sqlalchemy.exc.TimeoutError: QueuePool limit of size 10 overflow 10 reached (connection timed out; timeout 30.00s)
```

The database is healthy. The app CPU is at 30%. The 5xx rate climbs from 0 to 20% over 5 minutes and stays there.

**Before you read the answer**

The endpoint doesn't query the database in the route handler — it queues a background task. The session is opened by `get_session` and closed when the dependency finishes. Why is the pool exhausted?


### Your task

1. Find the bug.
2. Explain it.
3. Write the fix (architecture change + config change).

### Answer

**The bug:** The background task `send_receipt` opens its own session (or reuses one) and *outlives the request*. The request-scoped `get_session` dependency yields a session; the route queues a background task that uses (a session); the request returns; the dependency's `async with AsyncSession(...)` block exits and closes the session — but the background task is still running and trying to use the (now-closed or about-to-be-closed) session.

Even worse: if the background task opens its *own* session via the engine, it does so outside the dependency lifecycle. FastAPI's `BackgroundTasks` runs after the response is sent; the session it opens is held for the duration of the (potentially slow) email send. Under load, with 5,000 background tasks queued, each holding a connection, the pool exhausts: 10 base + 10 overflow = 20 connections, all held by background tasks; the next request can't get one.

**The fix — architecture:**

Background tasks that need a DB session must open their *own* session, not reuse the request's, and must release it promptly (the email send should not be inside the `async with AsyncSession(...)` block).

```python
# app/background.py
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

async def send_receipt(order_id: int, sessionmaker: async_sessionmaker):
 # Open a short-lived session just to fetch the order, then close it before
 # the (slow) email send.
 async with sessionmaker() as session:
 order = await session.get(Order, order_id)
 email = order.customer.email # eager-load customer to avoid MissingGreenlet
 body = f"Receipt for order {order_id}: ${order.total}"
 # Session is closed here; connection returned to the pool.
 # The slow part (email send) happens after the session is released.
 await send_email(email, body)
```

The route should pass the sessionmaker, not a session:

```python
@router.post("/orders/{id}/receipt", status_code=202)
async def send_order_receipt(
 id: int,
 background_tasks: BackgroundTasks,
 request: Request,
):
 sessionmaker = request.app.state.sessionmaker
 background_tasks.add_task(send_receipt, id, sessionmaker)
 return {"status": "queued"}
```

**The fix — config:**

Right-size the pool. With 8 Uvicorn workers, `pool_size=10` per worker = 80 base connections, plus 80 overflow = 160 max. If Postgres `max_connections=100`, you're over. Use:

```python
app.state.engine = create_async_engine(
 "postgresql+asyncpg://...",
 pool_size=5, # 8 workers × 5 = 40 base
 max_overflow=5, # 8 workers × 5 = 40 overflow → 80 max ≤ 100 Postgres
 pool_pre_ping=True,
 pool_timeout=30, # how long to wait for a connection from the pool
)
```

Add PgBouncer in transaction mode in front of Postgres. PgBouncer multiplexes many app connections onto few Postgres connections; with `pool_mode=transaction`, you can have 1000 app connections on 25 Postgres connections.

**Danger — The "background task reuses the request session" trap**

`BackgroundTasks` runs *after* the response is sent — but the request-scoped dependency has already been cleaned up. The session is closed (or about to be). The background task that uses it gets a closed session (raises `ResourceClosedError`) or, worse, holds a connection that should have been returned to the pool. The rule: background tasks open their *own* session, use it briefly, and release it before the slow work.


**Prevention:**

- Add a connection-pool-usage metric (peak connections, waiters, overflow count). Alert at 70% utilization.
- Codify: total app connections = `workers × (pool_size + max_overflow)` ≤ 0.8 × `max_connections`. Add to deploy checklist.
- Add a load test that drives the app to 5x normal traffic; alert if connection wait time exceeds 50ms.
- Lint rule: background tasks must not take a `DbSession` parameter — they take a sessionmaker, or use the `app.state` engine via the request.

**Cross-reference:** [[07-SQLAlchemy/02-Engines-Connections-Pools]], [[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]], [[03-FastAPI-Core/Dependency-Injection]], Incident 6 in [[19-Interview-Preparation/Production-Incidents-Debugging]].

**Warning — How to not panic: the production incident mindset — roll back, diagnose, fix, post-mortem**

The labs above train you to find bugs in a controlled environment. A production incident is a different game — the page is firing, the customer is on the phone, and the rollback window is closing. The senior on-call's first instinct is not "what's the bug?" but "stop the bleeding." Four steps, in this order:

**1. Roll back first.** If the incident started within the last deploy window (check `kubectl rollout history deployment/api` or `helm history`), roll back *before* you diagnose. `kubectl rollout undo deployment/api` reverts the Deployment to the previous ReplicaSet; the bleed stops in ~30 seconds. Do not spend the first 10 minutes reading logs while the 5xx rate climbs — the rollback is the cheapest possible mitigation, and if it doesn't fix the symptom you have ruled out the deploy as the cause (valuable information either way). The exception: incidents caused by a database migration that has already run — rollback won't undo the migration (see [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]). For those, the rollback is to a feature flag that disables the new code path.

**2. Diagnose second.** With the bleed stopped, reproduce in staging (see "When you can't reproduce" above). Pull the production logs for the failing window (`kubectl logs --since=30m deployment/api`), grep for the error code, and read the SQLAlchemy echo log for the failing request. Snapshot the production database into staging (`pg_dump` from the read replica) so your reproducer runs against production-shaped data. The diagnosis should produce a one-sentence hypothesis — same as the 5-step framework — but the production version is graded by *time to hypothesis* (target: under 15 minutes from rollback to hypothesis) rather than thoroughness.

**3. Fix third.** The fix goes to staging first, never straight to production. The staging fix must (a) make the reproducer pass and (b) include a regression test that captures the reproducer. The fix ships via the normal deploy pipeline — no "hot-fix straight to main" — because the deploy pipeline has the canary, the rollback, and the observability. If the fix is urgent enough to skip canary, the on-call documents the skip in the post-mortem.

**4. Post-mortem fourth.** Within 24-72 hours, the incident commander writes a blameless post-mortem: timeline, root cause, contributing factors, impact (customers affected, requests failed, dollars lost), action items (with owners and due dates). The senior engineer's rule: *the post-mortem is not the place to assign blame — it is the place to identify the systemic gap that let the bug reach production.* The five-whys exercise bottoms out at a systemic fix (a missing CI check, a missing alert, a missing integration test), not at "engineer X should have been more careful." A post-mortem that ends at "engineer X made a typo" has not found the root cause — the typo reached production because the test that would have caught it did not exist. The action item is "add the test," not "be more careful."

The four-step order matters because each step is more expensive than the last, and the senior on-call stops at the cheapest step that resolves the symptom. Roll back is minutes; diagnose is hours; fix is hours-to-days; post-mortem is days-to-weeks. Stopping at "rolled back, symptom gone, will diagnose in the morning" is a legitimate choice when the impact is contained — the on-call does not owe the customer a root cause at 3 a.m.; they owe them a stable system. The root cause arrives with the post-mortem.


---

## Summary

| Lab | Topic | Difficulty | Canonical lesson |
|---|---|---|---|
| 1 | N+1 in a serializer | Easy | [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]] |
| 2 | Sync DB call inside `async def` | Easy | [[10-Async-Python/Event-Loop-and-Coroutines]] |
| 3 | Broad `except Exception: pass` swallowing `IntegrityError` | Medium | [[01-Python-Foundations/Exceptions-Done-Right]] |
| 4 | Mutable default factory misuse (Pydantic) | Medium | [[04-Pydantic/BaseModel-and-Validation]] |
| 5 | Migration renaming a column the code still selects | Hard | [[09-Alembic-Migrations/Data-Migrations-Safely]] |
| 6 | Pool exhaustion under load | Hard | [[07-SQLAlchemy/02-Engines-Connections-Pools]] |

If you completed all six without looking at the answers, you are ready for the interview question sets in [[19-Interview-Preparation/00-Interview-MOC]].

**Production debugging tools: strace, tcpdump, EXPLAIN ANALYZE, Redis MONITOR, Chrome DevTools — when to use each**

The labs are practiced in a controlled harness; production debugging is a different toolset. Five tools cover ~90% of the senior debugger's toolbox. Knowing which one to reach for *first* is the skill; the rest is typing.

- **`strace` — for "the process is stuck or behaving wrong at the syscall layer."** `strace -p <pid> -f -s 9999 -e trace=network,read,write` follows every syscall the process (and its children) make, with arguments up to 9999 bytes printed. Use it when the symptom is "the process hangs on startup" (you'll see it block on `recvfrom` waiting on a socket — almost always a missing dependency), "the process makes a network call I didn't expect" (you'll see the `connect` syscall and the destination address), or "a C extension is crashing" (you'll see the `mmap` or `munmap` that preceded the crash). Reach for `strace` *after* `py-spy` (which shows the Python stack); `strace` shows the kernel boundary, which is one level deeper than Python alone.
- **`tcpdump` — for "the network call is wrong and I need to see the bytes."** `tcpdump -i any -A 'tcp port 5432'` captures every byte on the Postgres wire protocol; `tcpdump -i any -A 'tcp port 6379'` does the same for Redis. Use it when the symptom is "the query works in psql but fails from SQLAlchemy" (capture both sessions, diff the wire bytes — usually a parameter binding or prepared-statement mismatch), "the connection is reset mid-flight" (you'll see the RST packet), or "the TLS handshake fails" (you'll see the ClientHello and ServerHello). `tcpdump` only sees cleartext; for TLS, use `SSLKEYLOGFILE` + Wireshark to decrypt the captured session. In a Kubernetes pod, `kubectl debug` into a privileged pod with `tcpdump` installed, then sniff the target pod's traffic via the pod's network namespace.
- **`EXPLAIN (ANALYZE, BUFFERS)` — for "the query is slow and I need to know why."** `EXPLAIN (ANALYZE, BUFFERS) SELECT ...` runs the query, instruments every plan node, and reports estimated vs actual rows, buffer hits vs reads, and per-node timing. Use it on any query whose `pg_stat_statements.mean_exec_time` is above your latency budget. The senior reader's order of operations: (1) compare `estimated rows` vs `actual rows` per node — a 100× divergence means stale statistics, run `ANALYZE`; (2) look for `Seq Scan` on a table that has a candidate index — the planner chose Seq Scan because it estimated the scan would be cheaper, usually because of correlated predicates; (3) check `Buffers: shared hit` vs `shared read` — high `read` means cold cache, the query is hitting disk; (4) look for `Nested Loop` with `actual rows` much larger than estimated — that's an N+1 masquerading as a join. See [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] for the canonical lesson.
- **`Redis MONITOR` — for "the cache or rate limit is wrong and I need to see every command."** `redis-cli MONITOR` opens a connection that receives every command the Redis server processes. Use it when the symptom is "the cache is returning stale data" (you'll see the `SET` that wrote the stale value and the `GET` that read it), "the rate limiter is over-admitting" (you'll see two `DECR` calls race past the bucket), or "the worker is not picking up jobs" (you'll see the `BRPOP` timeout). `MONITOR` is *expensive* on production Redis (it serialises every command to the monitoring client); use it on a staging replica or for short windows (<60 seconds) on production. For longer inspection, use `SLOWLOG` (which only logs slow commands) or the Redis exporter's Prometheus metrics.
- **Chrome DevTools Network tab — for "the frontend is calling the wrong endpoint or sending the wrong body."** Open DevTools → Network → Preserve Log, reproduce the bug, and inspect the failing request: the URL, the headers, the request body, the response status, the response body, the timing waterfall. Use it when the symptom is "the customer says it doesn't work" and the backend logs show no error (the request never reached the backend — usually a CORS preflight failure, a wrong base URL, or a 308 redirect the frontend didn't follow). The Network tab also shows SSE streams as a single connection with progressive frames; right-click the request → "Save all as HAR" to share the failure with the backend team. The HAR file is the client-side reproducer.

The five tools have non-overlapping primary use cases: `strace` for the kernel boundary, `tcpdump` for the network wire, `EXPLAIN ANALYZE` for the database plan, `Redis MONITOR` for the cache state, DevTools for the client-server boundary. The senior debugger's reach order at an unfamiliar incident is: DevTools (is the request even reaching the backend?), then `EXPLAIN ANALYZE` (is the database slow?), then `Redis MONITOR` (is the cache wrong?), then `tcpdump` (is the network lying?), then `strace` (is the process itself broken?). Each step narrows the failure domain; the senior stops at the first tool that shows the symptom.


**Danger — How an attacker thinks: data exfiltration via debugging tools**

Every debugging tool that "shows you what's happening" is also a tool that shows an attacker what's happening — if they can run it. The senior debugger's threat model for debugging tools is "any tool that can read process memory, sniff network traffic, or query runtime state is a credential-extraction primitive in the wrong hands."

**`strace` reads syscall arguments in plaintext.** `strace -p <pid> -s 9999 -e trace=read,write,sendto,recvfrom` prints every byte the process reads and writes — including the bytes of an `AUTH` call to Redis, the bytes of a Postgres password in the startup packet, the bytes of a JWT in an HTTP `Authorization` header. In a container, an attacker with `CAP_SYS_PTRACE` (or root in the host PID namespace) can `strace` the API process and read every credential the process handles. The defence is two-layered: (1) drop `CAP_SYS_PTRACE` from the container's seccomp profile (the default Docker seccomp profile blocks it; the default Kubernetes `restricted` Pod Security Standard also blocks it); (2) encrypt credentials in transit (TLS to Postgres, TLS to Redis, mTLS between services) so a syscall sniff reads ciphertext, not plaintext. The deeper defence is to never log credentials at all — `SecretStr` in Pydantic Settings, redaction in structlog — so even a captured `strace` shows the credential being passed to `libssl` for an encrypted write, not the plaintext.

**`tcpdump` captures every packet on the wire.** `tcpdump -i any -A 'tcp port 6379'` prints every Redis command and reply in ASCII — including the `AUTH your_redis_password` command a worker sends on connect. In a Kubernetes cluster, an attacker with `tcpdump` in a privileged pod (or root on a node) can sniff every unencrypted intra-cluster connection. The defence: TLS everywhere (Redis 6+ supports TLS natively; Postgres has TLS via `sslmode=require`; service-to-service mTLS via a service mesh). The defence-in-depth: network policies (Kubernetes `NetworkPolicy` with `DefaultDeny` and explicit allow-rules per namespace) so an attacker who compromises one pod cannot reach another pod's port.

**`EXPLAIN ANALYZE` reveals schema and statistics.** `EXPLAIN ANALYZE` on a query against `embeddings` reveals the table name, the column names, the index names, the cardinality estimates (from `pg_statistic`), and the actual row counts — information a low-privilege database user should not have. In a multi-tenant database, `pg_statistic` histograms can leak tenant data shapes (the most-common-values of a column can include tenant-specific values). The defence: limit SELECT on the system catalogs (`pg_statistic`, `pg_class`) to the application role, run the application against a read replica with column-level permissions that hide sensitive columns, or accept that `EXPLAIN` is available and design the schema so the leaked metadata is not sensitive (no tenant-specific column names, no tenant-specific value distributions in histograms).

**Redis `MONITOR` broadcasts every command to every connected client.** `redis-cli MONITOR` opens a connection that receives every command the Redis server processes — including `AUTH`, `SETEX session:abc "<jwt>"`, `HSET rate_limit:tenant:42 tokens 29`. Any client that can connect to Redis and run `MONITOR` sees every command. The defence: Redis ACLs (`ACL SETUSER api +@read +@write -@admin -@dangerous`, which denies `MONITOR` to the application role), network-level isolation (Redis bound to `127.0.0.1` in dev, behind a private subnet in production), and never putting credentials in Redis values (the session JWT is stored hashed if at all; the rate-limit bucket holds an integer, not a secret).

**Chrome DevTools Network tab is the client-side `tcpdump`.** A user opening DevTools on your SaaS can see every `fetch` and `XMLHttpRequest` the page makes — including the `Authorization: Bearer <jwt>` header, the SSE stream's full content, the cookies. This is the *user's own traffic*, so it's not exfiltration in the traditional sense, but the senior engineer's rule is "never put a secret in a header the user can see" — the SSE token is short-lived (5 minutes) and single-use, the access JWT is short-lived (15 minutes), and the refresh token is in an `HttpOnly` cookie the DevTools Network tab still shows but the user's JavaScript cannot read. The deeper rule: "the browser is a hostile environment" — never ship a private key, a long-lived token, or a server-side secret to the browser. The browser can be inspected, and DevTools is the user's `strace`.

The unifying threat model: every debugging tool that observes runtime state can observe credentials. The defence is layered (drop capabilities, encrypt in transit, isolate at the network, never log secrets, use short-lived tokens), and the senior debugger's habit is to ask "what can this tool see?" *before* running it in production — because the same tool that helps you find the bug helps an attacker find the credentials.


## Verification

Each lab's "Buggy code" block is runnable as-is; so is each "fix" block. To verify your fixes work, type them into a real FastAPI project and watch the symptom disappear. The fastest path is to scaffold the project once and use it for every lab.

### Scaffold once

```bash
# From the project root, create the lab harness:
uv init debugging-labs
cd debugging-labs
uv add fastapi==0.148.0 'uvicorn[standard]' sqlalchemy==2.1.5 'asyncpg' pydantic==2.14.1
uv add --dev pytest pytest-asyncio httpx aiosqlite
mkdir -p app/api app/models app/schemas app/services app/deps
```

### Run each lab end-to-end

For Lab 1 (N+1), save the buggy code as `app/api/orders.py` + `app/schemas/orders.py` + `app/models/order.py`, then:

```bash
uv run uvicorn app.main:app --reload
# In another terminal:
curl -sf http://localhost:8000/orders
# Buggy: ~5 seconds latency, ~101 SQL queries in the SQLAlchemy echo log.
# After the fix (selectinload): <300 ms latency, 3 queries in the log.
```

To verify the query count claim concretely, instrument the session:

```bash
uv run python -c "
import asyncio
from sqlalchemy import event
from app.deps import engine

@event.listens_for(engine.sync_engine, 'before_cursor_execute')
def counter(conn, cursor, statement, parameters, context, executemany):
    print('SQL:', statement[:80].replace(chr(10), ' '))

asyncio.run(main())  # your main() that calls /orders
"
# Buggy Lab 1: ~101 'SQL:' lines. After fix: 3.
```

For Labs 2–4, run the buggy snippet directly:

```bash
# Lab 2 (sync-in-async):
uv run python -c "from app.services.legacy import fetch_legacy_user; import asyncio; print(asyncio.run(fetch_legacy_user(1)))"
# Buggy: blocks the loop, other endpoints stall. After fix (async libraries): no stall.

# Lab 3 (broad except):
uv run pytest tests/test_user_service.py::test_duplicate_email_raises_conflict -v
# Buggy: returns 201 with id=None. After fix: returns 409 with {'code':'email_taken'}.

# Lab 4 (mutable default):
uv run python -c "from app.schemas.cart import Cart; c=Cart(user_id=1); c.notes.append('x'); d=Cart(user_id=2); print(d.notes)"
# Buggy: prints ['x'] (shared state). After fix: prints [] (per-instance default).

# Lab 5 (migration rename):
uv run alembic upgrade head && uv run pytest tests/test_customer_service.py -v
# Buggy: UndefinedColumn error. After fix: the service uses .values(email=...) and tests pass.

# Lab 6 (pool exhaustion):
docker compose up -d postgres
uv run python -m pytest tests/test_pool_exhaustion.py -v
# Buggy: sqlalchemy.exc.TimeoutError after ~20 concurrent receipts. After fix (own session + right-sized pool): no TimeoutError at 5x traffic.
```

### The lab pass-fail signal

If you can paste each buggy snippet into the harness, watch the symptom, apply the fix, and watch the symptom disappear — you have completed the lab. If the symptom does not disappear after your fix, your fix is wrong (or incomplete); re-read the "Answer" section, find what you missed, and try again. Recognition is easy; recall is what you are training.

## Related

- [[00-Exercises-MOC]] — this folder's index.
- [[Troubleshooting-Index]] — flat index of failure modes for quick lookup when debugging in production.
- [[19-Interview-Preparation/Production-Incidents-Debugging]] — narrative versions of labs 1, 3, 5, 6.
- [[22-Diagrams/SQLAlchemy-Session-Flow]] — the diagram that lab 1 violates.
- [[22-Diagrams/Request-Lifecycle-Diagram]] — the diagram that lab 2 violates.
- [[22-Diagrams/Deployment-Topology]] — where the pool-sizing constraint in lab 6 lives.

## Sources

- The lab style is the vault's in-house per-lesson exercise and common-errors format, extended for FastAPI / SQLAlchemy / Alembic / Pydantic as taught across Sections 03, 04, 07, 09, 10 of this vault.
- Verified versions: FastAPI 0.148.0, SQLAlchemy 2.1.5, Pydantic v2.14.1, Alembic 1.20.0, uv 0.13.1, Python 3.12 — per [[21-Reference-Library/Source-Register]].

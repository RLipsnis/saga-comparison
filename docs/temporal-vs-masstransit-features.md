# Temporal vs MassTransit/RabbitMQ: Developer Efficiency & Built-in Features

This document provides a structured comparison of **out-of-the-box capabilities** between
Temporal (Orchestration) and MassTransit + RabbitMQ (Choreography) as observed in this
saga comparison project. It is intended to support the thesis argument around developer
efficiency, maintenance cost, and operational overhead.

---

## 1. Workflow Visibility & Debugging

| Capability | Temporal | MassTransit + RabbitMQ |
|---|---|---|
| **Execution history** | Built-in. Every workflow has a full event history showing each activity start, completion, failure, and retry — viewable in the Temporal UI or via API. | Must be built manually. Requires custom logging, correlation IDs, and an aggregation tool (ELK, Seq) to reconstruct event flow across services. |
| **Web UI dashboard** | Built-in (`temporal-ui`). Shows running/completed/failed workflows, searchable by workflow ID, type, status, and time range. | RabbitMQ Management UI shows queues and message rates, but has **no workflow-level visibility**. A separate tool (e.g., custom dashboard, Jaeger) is needed. |
| **Workflow state inspection** | Can query any running workflow's current state, pending activities, and stack trace in real time via `DescribeWorkflowExecution`. | Saga state is in the database (EF Core). Requires custom API endpoint or direct DB query to inspect. |
| **Search & filtering** | Built-in search attributes: filter workflows by custom fields (e.g., `CustomerId`, `OrderId`), status, time range. SQL-like query syntax. | No equivalent. Must build custom search queries against your saga state table. |

**Impact**: Temporal eliminates the need to build a custom "saga tracking dashboard." In this project, MassTransit required building `OrdersController.GetStatus()` and `Stream()` endpoints manually.

---

## 2. Retry & Error Handling

| Capability | Temporal | MassTransit + RabbitMQ |
|---|---|---|
| **Automatic retries** | Built into the workflow engine. Configured per-activity via `RetryPolicy` (max attempts, backoff, non-retryable errors). Zero application code needed. | Must configure `UseMessageRetry()` at the bus level. Retry logic runs inside the consumer process — if the process crashes mid-retry, state is lost until redelivery. |
| **Retry visibility** | Each retry attempt is recorded in the workflow event history with timestamps and error details. | Retries happen silently within the consumer pipeline. Must add custom logging to track retry count. |
| **Non-retryable errors** | Can specify `NonRetryableErrorTypes` in `RetryPolicy` to immediately fail on business errors (e.g., insufficient funds). | Must throw specific exception types or implement custom `IRetryPolicy` to distinguish transient from permanent failures. |
| **Timeouts** | `StartToCloseTimeout`, `ScheduleToCloseTimeout`, `HeartbeatTimeout` — all per-activity, enforced by the server even if the worker dies. | `UseTimeout()` on consumer pipeline, but it's local to the process. If the process crashes, timeout doesn't fire. |

**Impact**: Temporal's retry handling is server-enforced and observable. MassTransit retries are in-process only.

---

## 3. Compensation (Saga Rollback)

| Capability | Temporal | MassTransit + RabbitMQ |
|---|---|---|
| **Compensation pattern** | Explicit in workflow code: a `compensations` list with `try/catch` — deterministic, sequential, visible in history. | Distributed across state machine transitions. Each compensation is a separate event + consumer pair. Harder to reason about order. |
| **Compensation tracking** | Each compensation activity appears in the workflow event history. You can see which compensations ran and whether they succeeded. | No built-in tracking. Must add flags to saga state (`CompensatingInventory`, `InventoryCompensated`) and custom logging. |
| **Partial failure handling** | If a compensation fails, the workflow can retry it, log it, or escalate — all within the same workflow. | If a compensation message is lost or the consumer crashes, the saga can get stuck in `Compensating` state permanently unless a timeout/watchdog is built. |

**Impact**: In this project, the MassTransit saga required 4 boolean flags and a custom `IsCompensationComplete()` method to track compensation. Temporal handles this implicitly.

---

## 4. Audit Trail & Compliance

| Capability | Temporal | MassTransit + RabbitMQ |
|---|---|---|
| **Full audit log** | Every workflow execution is an immutable event log: who started it, each step, each failure, each retry, final outcome. Retained for configurable duration. | Must build: write to a separate audit table, log to ELK/Seq, or use RabbitMQ message tracing (which only shows queue-level events). |
| **Replay / time travel** | Workflows can be replayed deterministically from their event history for debugging. | No equivalent. Must reconstruct from logs/DB snapshots. |
| **Retention policies** | Configurable per namespace (e.g., retain workflow history for 30 days). | Must implement TTL on audit tables or log rotation manually. |

**Impact**: For regulated industries, Temporal provides compliance-ready audit trails out of the box. With MassTransit, this is a significant custom development effort.

---

## 5. Operational Tooling

| Capability | Temporal | MassTransit + RabbitMQ |
|---|---|---|
| **Terminate workflow** | `TerminateWorkflow` API / UI — immediately stops a running workflow. | Must manually purge messages from queues and update saga state in DB. |
| **Cancel workflow** | `CancelWorkflow` — graceful cancellation with cleanup. | No built-in cancel. Must publish a custom cancellation event and handle it in the state machine. |
| **Reset workflow** | Can reset a workflow to a specific point in its history and re-run from there. | Not possible. Must create a new saga instance. |
| **Signal workflow** | Can send signals (external events) to a running workflow to modify behavior mid-flight. | Must publish events to queues and handle them in the state machine — requires new states and transitions. |
| **Batch operations** | Batch terminate/cancel/signal via API. | No equivalent. |

---

## 6. Development Complexity (Lines of Code)

Measured from this project's codebase:

| Component | Temporal (Orchestration) | MassTransit (Choreography) |
|---|---|---|
| **Saga/Workflow definition** | `OrderSagaWorkflow.cs` (~140 lines) — single file, linear flow | `OrderSagaStateMachine.cs` (~187 lines) + `OrderSagaState.cs` + `OrderSagaStateMap.cs` (~1800 lines total across state + map) |
| **Activity/Consumer code** | `OrderActivities.cs` (165 lines) — single class, all steps | 4 separate consumer classes across 4 services |
| **Compensation logic** | ~15 lines (inline list + reverse loop) | ~40 lines of compensation state tracking + boolean flags |
| **Error handling** | Single try/catch in workflow | Distributed across state machine `When(...Failed)` handlers |
| **DB status updates** | 1 activity call per status change | Separate `UpdateOrderConsumer` classes (4 consumers, ~107 lines) |

**Impact**: Orchestration centralizes saga logic. Choreography distributes it, requiring more boilerplate, more files, and more coordination.

---

## 7. Infrastructure Requirements

| Aspect | Temporal | MassTransit + RabbitMQ |
|---|---|---|
| **Required infrastructure** | Temporal Server + DB (PostgreSQL) | RabbitMQ broker |
| **Resource footprint** | Higher: Temporal server is a multi-component system (frontend, history, matching, worker services) | Lower: RabbitMQ is a single process, lightweight |
| **Operational complexity** | Must manage Temporal cluster (or use Temporal Cloud) | RabbitMQ is simpler to operate, well-understood |
| **Scaling model** | Scale workers independently; server handles coordination | Scale consumers independently; each service is autonomous |

**Impact**: Temporal has higher infrastructure overhead but provides more capabilities per resource dollar.

---

## 8. Summary Matrix

| Dimension | Temporal Advantage | MassTransit Advantage |
|---|---|---|
| Visibility & debugging | ✅ Built-in UI, full history | |
| Retry handling | ✅ Server-enforced, observable | |
| Compensation tracking | ✅ Implicit in workflow | |
| Audit trail | ✅ Out-of-the-box | |
| Operational tooling | ✅ Terminate, cancel, reset, signal | |
| Code complexity | ✅ Fewer files, linear flow | |
| Infrastructure simplicity | | ✅ Lighter footprint |
| Service autonomy | | ✅ No central coordinator |
| Coupling | | ✅ Loose coupling by design |
| Message broker flexibility | | ✅ Swap RabbitMQ for any broker |

---

## 9. Recommended Thesis Framing

> Temporal provides a **higher-level abstraction** that bundles workflow visibility, retry
> management, compensation tracking, and audit logging into the platform. MassTransit + RabbitMQ
> provides a **lower-level building block** approach where each of these capabilities must be
> implemented by the developer. The trade-off is **infrastructure complexity** (Temporal) vs
> **development complexity** (MassTransit).
>
> For teams that need strong observability, auditability, and operational control over long-running
> business processes, Temporal reduces the total cost of ownership despite higher infrastructure
> requirements. For teams that prioritize service autonomy, minimal infrastructure, and loose
> coupling, MassTransit + RabbitMQ provides a leaner foundation at the cost of more custom code.

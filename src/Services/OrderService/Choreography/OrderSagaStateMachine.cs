using MassTransit;
using Shared.Contracts;

namespace OrderService.Choreography;

// Choreography saga state machine driving the Order saga.
//
// Sequencing notes:
//   * Each transition calls Publish(...) before TransitionTo(...). MassTransit defers the
//     actual broker send until the saga transaction commits, so a rollback drops the
//     published messages together with the state change. That gives "at most once"
//     send-with-commit semantics on the PostgreSQL saga repository.
//   * The inverse failure mode (commit succeeds, broker publish fails) is the classic
//     dual-write problem. Without a transactional outbox (intentionally not configured
//     here so the broker footprint matches a vanilla RabbitMQ deployment), a failed
//     publish after a successful commit would leak messages. Temporal does not have this
//     issue because its history + visibility stores are written atomically by the server.
//
// Order.Status sequencing:
//   * OrderCompensating is published BEFORE compensation commands (ReleaseInventory,
//     RefundPayment) so the Order.Status column advances to "Compensating" before the
//     rollback starts — matching the Temporal catch block's UpdateOrderStatusAsync(
//     "Compensating", ...) call.
//   * OrderFailed is published only from the guarded "all compensations complete" branch
//     or the direct Initial→Failed branch, so the Order.Status is never flipped to
//     "Failed" while compensation is still in flight.
public class OrderSagaStateMachine : MassTransitStateMachine<OrderSagaState>
{
    public State ReservingInventory { get; private set; } = null!;
    public State ProcessingPayment { get; private set; } = null!;
    public State ArrangingShipping { get; private set; } = null!;
    public State SendingNotification { get; private set; } = null!;
    public State Completed { get; private set; } = null!;
    public State Failed { get; private set; } = null!;
    public State Compensating { get; private set; } = null!;

    public Event<OrderCreated> OrderCreatedEvent { get; private set; } = null!;
    public Event<InventoryReserved> InventoryReservedEvent { get; private set; } = null!;
    public Event<InventoryReservationFailed> InventoryReservationFailedEvent { get; private set; } = null!;
    public Event<InventoryReleased> InventoryReleasedEvent { get; private set; } = null!;
    public Event<PaymentProcessed> PaymentProcessedEvent { get; private set; } = null!;
    public Event<PaymentFailed> PaymentFailedEvent { get; private set; } = null!;
    public Event<PaymentRefunded> PaymentRefundedEvent { get; private set; } = null!;
    public Event<ShippingArranged> ShippingArrangedEvent { get; private set; } = null!;
    public Event<ShippingFailed> ShippingFailedEvent { get; private set; } = null!;
    public Event<ShippingCancelled> ShippingCancelledEvent { get; private set; } = null!;
    public Event<NotificationSent> NotificationSentEvent { get; private set; } = null!;

    public OrderSagaStateMachine()
    {
        InstanceState(x => x.CurrentState);

        // Event correlation — all by OrderId
        Event(() => OrderCreatedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => InventoryReservedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => InventoryReservationFailedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => InventoryReleasedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => PaymentProcessedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => PaymentFailedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => PaymentRefundedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => ShippingArrangedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => ShippingFailedEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => ShippingCancelledEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => NotificationSentEvent, x => x.CorrelateById(ctx => ctx.Message.OrderId));

        // === Initially ===
        Initially(
            When(OrderCreatedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.CustomerId = ctx.Message.CustomerId;
                    ctx.Saga.ItemsJson = System.Text.Json.JsonSerializer.Serialize(ctx.Message.Items);
                    ctx.Saga.TotalAmount = ctx.Message.Items.Sum(i => i.Quantity * i.UnitPrice);
                    ctx.Saga.Address = "Default Address";
                    ctx.Saga.CreatedAt = ctx.Message.CreatedAt;

                    LogTransition(ctx, "Initial", "ReservingInventory");
                })
                .Publish(ctx => new ReserveInventory(ctx.Saga.CorrelationId, ctx.Message.Items))
                .TransitionTo(ReservingInventory)
        );

        // === ReservingInventory ===
        During(ReservingInventory,
            When(InventoryReservedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.InventoryReservedAt = DateTime.UtcNow;
                    LogTransition(ctx, "ReservingInventory", "ProcessingPayment");
                })
                .Publish(ctx => new ProcessPayment(ctx.Saga.CorrelationId, ctx.Saga.CustomerId, ctx.Saga.TotalAmount))
                .TransitionTo(ProcessingPayment),

            When(InventoryReservationFailedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.FailureReason = ctx.Message.Reason;
                    LogTransition(ctx, "ReservingInventory", "Failed (no compensation needed)");
                })
                // Publish business-level failure events so the Order.Status is written by a single
                // consumer AFTER the state machine has committed the transition. This replaces the
                // previous design where UpdateOrderOnFailed raced the state machine on the same
                // InventoryReservationFailed event.
                .Publish(ctx => new OrderFailed(ctx.Saga.CorrelationId, ctx.Saga.FailureReason ?? "Unknown", DateTime.UtcNow))
                // Failure notification (symmetric with the Temporal workflow's catch block).
                .Publish(ctx => new SendNotification(ctx.Saga.CorrelationId, ctx.Saga.CustomerId, "OrderFailed",
                    $"Your order {ctx.Saga.CorrelationId} has failed: {ctx.Saga.FailureReason}"))
                .TransitionTo(Failed)
                .Finalize()
        );

        // === ProcessingPayment ===
        During(ProcessingPayment,
            When(PaymentProcessedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.PaymentProcessedAt = DateTime.UtcNow;
                    LogTransition(ctx, "ProcessingPayment", "ArrangingShipping");
                })
                .Publish(ctx => new ArrangeShipping(ctx.Saga.CorrelationId, ctx.Saga.CustomerId, ctx.Saga.Address!))
                .TransitionTo(ArrangingShipping),

            When(PaymentFailedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.FailureReason = ctx.Message.Reason;
                    ctx.Saga.CompensatingInventory = true;
                    ctx.Saga.InventoryCompensated = false;
                    LogTransition(ctx, "ProcessingPayment", "Compensating (releasing inventory)");
                })
                // Emit OrderCompensating so the Order.Status column is advanced to "Compensating"
                // before compensation commands start flowing. The orchestrator's catch block does
                // the same thing via UpdateOrderStatusAsync("Compensating", ...).
                .Publish(ctx => new OrderCompensating(ctx.Saga.CorrelationId, ctx.Saga.FailureReason ?? "Unknown", DateTime.UtcNow))
                .Publish(ctx => new ReleaseInventory(ctx.Saga.CorrelationId,
                    System.Text.Json.JsonSerializer.Deserialize<List<OrderItemDto>>(ctx.Saga.ItemsJson)!))
                .TransitionTo(Compensating)
        );

        // === ArrangingShipping ===
        During(ArrangingShipping,
            When(ShippingArrangedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.TrackingNumber = ctx.Message.TrackingNumber;
                    ctx.Saga.ShippingArrangedAt = DateTime.UtcNow;
                    LogTransition(ctx, "ArrangingShipping", "SendingNotification");
                })
                .Publish(ctx => new SendNotification(ctx.Saga.CorrelationId, ctx.Saga.CustomerId,
                    "OrderCompleted",
                    $"Your order {ctx.Saga.CorrelationId} has been completed. Tracking: {ctx.Saga.TrackingNumber}"))
                .TransitionTo(SendingNotification),

            When(ShippingFailedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.FailureReason = ctx.Message.Reason;
                    ctx.Saga.CompensatingInventory = true;
                    ctx.Saga.CompensatingPayment = true;
                    ctx.Saga.InventoryCompensated = false;
                    ctx.Saga.PaymentCompensated = false;
                    LogTransition(ctx, "ArrangingShipping", "Compensating (refunding + releasing)");
                })
                .Publish(ctx => new OrderCompensating(ctx.Saga.CorrelationId, ctx.Saga.FailureReason ?? "Unknown", DateTime.UtcNow))
                .Publish(ctx => new RefundPayment(ctx.Saga.CorrelationId, ctx.Saga.TotalAmount))
                .Publish(ctx => new ReleaseInventory(ctx.Saga.CorrelationId,
                    System.Text.Json.JsonSerializer.Deserialize<List<OrderItemDto>>(ctx.Saga.ItemsJson)!))
                .TransitionTo(Compensating)
        );

        // === SendingNotification ===
        During(SendingNotification,
            When(NotificationSentEvent)
                .Then(ctx =>
                {
                    ctx.Saga.NotificationSentAt = DateTime.UtcNow;
                    ctx.Saga.CompletedAt = DateTime.UtcNow;
                    LogTransition(ctx, "SendingNotification", "Completed");
                })
                .TransitionTo(Completed)
                .Finalize()
        );

        // === Compensating ===
        During(Compensating,
            When(InventoryReleasedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.InventoryCompensated = true;
                    LogCompensation(ctx, "InventoryReleased");
                })
                .If(ctx => IsCompensationComplete(ctx.Saga), x => x
                    .Then(ctx => LogTransition(ctx, "Compensating", "Failed (all compensations done)"))
                    // Only now (after all compensations finished) advance the Order to Failed and
                    // send the failure notification — matching the sequencing of the Temporal
                    // workflow's catch block.
                    .Publish(ctx => new OrderFailed(ctx.Saga.CorrelationId, ctx.Saga.FailureReason ?? "Unknown", DateTime.UtcNow))
                    .Publish(ctx => new SendNotification(ctx.Saga.CorrelationId, ctx.Saga.CustomerId, "OrderFailed",
                        $"Your order {ctx.Saga.CorrelationId} has failed: {ctx.Saga.FailureReason}"))
                    .TransitionTo(Failed)
                    .Finalize()),

            When(PaymentRefundedEvent)
                .Then(ctx =>
                {
                    ctx.Saga.PaymentCompensated = true;
                    LogCompensation(ctx, "PaymentRefunded");
                })
                .If(ctx => IsCompensationComplete(ctx.Saga), x => x
                    .Then(ctx => LogTransition(ctx, "Compensating", "Failed (all compensations done)"))
                    .Publish(ctx => new OrderFailed(ctx.Saga.CorrelationId, ctx.Saga.FailureReason ?? "Unknown", DateTime.UtcNow))
                    .Publish(ctx => new SendNotification(ctx.Saga.CorrelationId, ctx.Saga.CustomerId, "OrderFailed",
                        $"Your order {ctx.Saga.CorrelationId} has failed: {ctx.Saga.FailureReason}"))
                    .TransitionTo(Failed)
                    .Finalize()),

            When(ShippingCancelledEvent)
                .Then(ctx => LogCompensation(ctx, "ShippingCancelled"))
        );

    }

    private static bool IsCompensationComplete(OrderSagaState saga)
    {
        if (saga.CompensatingInventory && !saga.InventoryCompensated) return false;
        if (saga.CompensatingPayment && !saga.PaymentCompensated) return false;
        return true;
    }

    private static void LogTransition<T>(BehaviorContext<OrderSagaState, T> ctx, string from, string to)
        where T : class
    {
        // Uses Console.WriteLine as MassTransit state machines don't easily inject ILogger
        Console.WriteLine($"[Saga] OrderId={ctx.Saga.CorrelationId}: {from} → {to}");
    }

    private static void LogCompensation<T>(BehaviorContext<OrderSagaState, T> ctx, string step)
        where T : class
    {
        Console.WriteLine($"[Saga] OrderId={ctx.Saga.CorrelationId}: Compensation step completed: {step}");
    }
}

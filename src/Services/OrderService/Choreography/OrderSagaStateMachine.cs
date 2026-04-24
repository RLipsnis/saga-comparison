using MassTransit;
using Shared.Contracts;

namespace OrderService.Choreography;

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

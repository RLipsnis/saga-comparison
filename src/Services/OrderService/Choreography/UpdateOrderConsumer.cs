using MassTransit;
using Microsoft.EntityFrameworkCore;
using OrderService.Domain;
using OrderService.Infrastructure;
using Shared.Contracts;

namespace OrderService.Choreography;

// Order.Status consumers for the choreography pattern.
//
// Each consumer reacts to a SINGLE business-level event emitted by the state machine
// (OrderCompleted / OrderCompensating / OrderFailed). This replaces the earlier design
// where four consumers listened to intermediate step-failure events in parallel with the
// saga state machine — which caused Order.Status to flip to "Failed" before compensation
// had a chance to run, making the failure path non-comparable with the Temporal catch
// block (which only writes "Failed" AFTER compensation).
//
// Note (dual-write): the Publish() calls in the state machine happen inside the saga DB
// transaction. If RabbitMQ is unreachable after the state commits, the Order.Status
// consumer never fires and the Order row stays "Pending" until an operator intervenes.
// Temporal avoids this by durably owning workflow state. For a stronger guarantee here
// we'd configure MassTransit's transactional outbox — intentionally left out to keep the
// broker footprint comparable to a vanilla choreography deployment.

public class UpdateOrderOnCompleted : IConsumer<OrderCompleted>
{
    private readonly OrderDbContext _db;
    private readonly ILogger<UpdateOrderOnCompleted> _logger;

    public UpdateOrderOnCompleted(OrderDbContext db, ILogger<UpdateOrderOnCompleted> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<OrderCompleted> context)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == context.Message.OrderId);
        if (order is null || order.Status == OrderStatus.Completed) return;

        order.Status = OrderStatus.Completed;
        order.CompletedAt = context.Message.CompletedAt;
        await _db.SaveChangesAsync();

        _logger.LogInformation("[Choreography] Order {OrderId} marked as Completed", order.Id);
    }
}

public class UpdateOrderOnCompensating : IConsumer<OrderCompensating>
{
    private readonly OrderDbContext _db;
    private readonly ILogger<UpdateOrderOnCompensating> _logger;

    public UpdateOrderOnCompensating(OrderDbContext db, ILogger<UpdateOrderOnCompensating> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<OrderCompensating> context)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == context.Message.OrderId);
        // Only advance forward from Pending/intermediate states. Never overwrite a terminal state.
        if (order is null || order.Status is OrderStatus.Completed or OrderStatus.Failed or OrderStatus.Compensating) return;

        order.Status = OrderStatus.Compensating;
        order.FailureReason = context.Message.Reason;
        await _db.SaveChangesAsync();

        _logger.LogInformation("[Choreography] Order {OrderId} marked as Compensating: {Reason}", order.Id, context.Message.Reason);
    }
}

public class UpdateOrderOnFailed : IConsumer<OrderFailed>
{
    private readonly OrderDbContext _db;
    private readonly ILogger<UpdateOrderOnFailed> _logger;

    public UpdateOrderOnFailed(OrderDbContext db, ILogger<UpdateOrderOnFailed> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<OrderFailed> context)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == context.Message.OrderId);
        if (order is null || order.Status == OrderStatus.Failed) return;

        order.Status = OrderStatus.Failed;
        order.FailureReason = context.Message.Reason;
        order.CompletedAt = context.Message.FailedAt;
        await _db.SaveChangesAsync();

        _logger.LogInformation("[Choreography] Order {OrderId} marked as Failed: {Reason}", order.Id, context.Message.Reason);
    }
}

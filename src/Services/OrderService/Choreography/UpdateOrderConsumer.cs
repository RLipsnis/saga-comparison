using MassTransit;
using Microsoft.EntityFrameworkCore;
using OrderService.Domain;
using OrderService.Infrastructure;
using Shared.Contracts;

namespace OrderService.Choreography;

public class UpdateOrderOnCompleted : IConsumer<NotificationSent>
{
    private readonly OrderDbContext _db;
    private readonly ILogger<UpdateOrderOnCompleted> _logger;

    public UpdateOrderOnCompleted(OrderDbContext db, ILogger<UpdateOrderOnCompleted> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<NotificationSent> context)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == context.Message.OrderId);
        if (order is null || order.Status == OrderStatus.Completed) return;

        order.Status = OrderStatus.Completed;
        order.CompletedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        _logger.LogInformation("[Choreography] Order {OrderId} marked as Completed", order.Id);
    }
}

public class UpdateOrderOnFailed : IConsumer<InventoryReservationFailed>
{
    private readonly OrderDbContext _db;
    private readonly ILogger<UpdateOrderOnFailed> _logger;

    public UpdateOrderOnFailed(OrderDbContext db, ILogger<UpdateOrderOnFailed> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<InventoryReservationFailed> context)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == context.Message.OrderId);
        if (order is null || order.Status == OrderStatus.Failed) return;

        order.Status = OrderStatus.Failed;
        order.FailureReason = context.Message.Reason;
        order.CompletedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        _logger.LogInformation("[Choreography] Order {OrderId} marked as Failed: {Reason}", order.Id, context.Message.Reason);
    }
}

public class UpdateOrderOnPaymentFailed : IConsumer<PaymentFailed>
{
    private readonly OrderDbContext _db;
    private readonly ILogger<UpdateOrderOnPaymentFailed> _logger;

    public UpdateOrderOnPaymentFailed(OrderDbContext db, ILogger<UpdateOrderOnPaymentFailed> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<PaymentFailed> context)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == context.Message.OrderId);
        if (order is null || order.Status == OrderStatus.Failed) return;

        order.Status = OrderStatus.Failed;
        order.FailureReason = context.Message.Reason;
        order.CompletedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        _logger.LogInformation("[Choreography] Order {OrderId} marked as Failed (payment): {Reason}", order.Id, context.Message.Reason);
    }
}

public class UpdateOrderOnShippingFailed : IConsumer<ShippingFailed>
{
    private readonly OrderDbContext _db;
    private readonly ILogger<UpdateOrderOnShippingFailed> _logger;

    public UpdateOrderOnShippingFailed(OrderDbContext db, ILogger<UpdateOrderOnShippingFailed> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<ShippingFailed> context)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == context.Message.OrderId);
        if (order is null || order.Status == OrderStatus.Failed) return;

        order.Status = OrderStatus.Failed;
        order.FailureReason = context.Message.Reason;
        order.CompletedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        _logger.LogInformation("[Choreography] Order {OrderId} marked as Failed (shipping): {Reason}", order.Id, context.Message.Reason);
    }
}

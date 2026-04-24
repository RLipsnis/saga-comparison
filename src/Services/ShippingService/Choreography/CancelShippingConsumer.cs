using MassTransit;
using ShippingService.Domain;
using ShippingService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace ShippingService.Choreography;

public class CancelShippingConsumer : IConsumer<CancelShipping>
{
    private readonly ShippingDbContext _db;
    private readonly ILogger<CancelShippingConsumer> _logger;

    public CancelShippingConsumer(ShippingDbContext db, ILogger<CancelShippingConsumer> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<CancelShipping> context)
    {
        var command = context.Message;
        _logger.LogInformation("[Choreography] CancelShipping (compensation) for OrderId={OrderId}", command.OrderId);

        var result = await ShippingOperations.CancelAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "CancelShipping", result.Event!);
        await context.Publish(result.Event!);

        _logger.LogInformation("[Choreography] ShippingCancelled published for OrderId={OrderId}", command.OrderId);
    }
}

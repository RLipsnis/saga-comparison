using MassTransit;
using ShippingService.Domain;
using ShippingService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace ShippingService.Choreography;

public class ArrangeShippingConsumer : IConsumer<ArrangeShipping>
{
    private readonly ShippingDbContext _db;
    private readonly ILogger<ArrangeShippingConsumer> _logger;

    public ArrangeShippingConsumer(ShippingDbContext db, ILogger<ArrangeShippingConsumer> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<ArrangeShipping> context)
    {
        var command = context.Message;
        _logger.LogInformation("[Choreography] ArrangeShipping for OrderId={OrderId}", command.OrderId);

        var result = await ShippingOperations.ArrangeAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "ArrangeShipping", result.Event!);
        await context.Publish(result.Event!);

        _logger.LogInformation("[Choreography] ShippingArranged published for OrderId={OrderId}, Tracking={Tracking}",
            command.OrderId, result.Event!.TrackingNumber);
    }
}

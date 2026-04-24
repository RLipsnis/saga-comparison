using MassTransit;
using InventoryService.Domain;
using InventoryService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace InventoryService.Choreography;

public class ReleaseInventoryConsumer : IConsumer<ReleaseInventory>
{
    private readonly InventoryDbContext _db;
    private readonly ILogger<ReleaseInventoryConsumer> _logger;

    public ReleaseInventoryConsumer(InventoryDbContext db, ILogger<ReleaseInventoryConsumer> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<ReleaseInventory> context)
    {
        var command = context.Message;
        _logger.LogInformation("[Choreography] ReleaseInventory (compensation) for OrderId={OrderId}", command.OrderId);

        var result = await InventoryOperations.ReleaseAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "ReleaseInventory", result.Event!);
        await context.Publish(result.Event!);

        _logger.LogInformation("[Choreography] InventoryReleased published for OrderId={OrderId}", command.OrderId);
    }
}

using MassTransit;
using Microsoft.EntityFrameworkCore;
using InventoryService.Domain;
using InventoryService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace InventoryService.Choreography;

public class ReserveInventoryConsumer : IConsumer<ReserveInventory>
{
    private readonly InventoryDbContext _db;
    private readonly ILogger<ReserveInventoryConsumer> _logger;

    public ReserveInventoryConsumer(InventoryDbContext db, ILogger<ReserveInventoryConsumer> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<ReserveInventory> context)
    {
        var command = context.Message;
        _logger.LogInformation("[Choreography] ReserveInventory for OrderId={OrderId}", command.OrderId);

        var result = await InventoryOperations.ReserveAsync(_db, command);

        if (!result.Success)
        {
            _logger.LogWarning("[Choreography] ReserveInventory failed for OrderId={OrderId}: {Error}", command.OrderId, result.Error);
            await _db.SaveChangesAsync();
            await context.Publish(new InventoryReservationFailed(command.OrderId, result.Error!));
            return;
        }

        try
        {
            await _db.SaveChangesAsync();
        }
        catch (DbUpdateConcurrencyException)
        {
            _logger.LogWarning("[Choreography] Concurrency conflict for OrderId={OrderId}, will retry via MassTransit", command.OrderId);
            throw; // MassTransit will retry
        }

        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "ReserveInventory", result.Event!);
        await context.Publish(result.Event!);
        _logger.LogInformation("[Choreography] InventoryReserved published for OrderId={OrderId}", command.OrderId);
    }
}

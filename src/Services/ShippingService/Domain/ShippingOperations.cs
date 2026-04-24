using Microsoft.EntityFrameworkCore;
using ShippingService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace ShippingService.Domain;

public record ArrangeResult(bool Success, string? Error, ShippingArranged? Event);
public record CancelResult(bool Success, ShippingCancelled? Event);

public static class ShippingOperations
{
    private static readonly Random Rng = new();

    public static async Task<ArrangeResult> ArrangeAsync(ShippingDbContext db, ArrangeShipping command)
    {
        var cached = await IdempotencyHelper.CheckAsync<ShippingArranged>(db, command.OrderId, "ArrangeShipping");
        if (cached is not null)
            return new ArrangeResult(true, null, cached);

        // Simulate shipping arrangement delay
        await Task.Delay(Rng.Next(30, 101));

        var trackingNumber = $"TRK-{Guid.NewGuid():N}"[..12].ToUpper();

        var shipment = new Shipment
        {
            Id = Guid.NewGuid(),
            OrderId = command.OrderId,
            CustomerId = command.CustomerId,
            Address = command.Address,
            TrackingNumber = trackingNumber,
            Status = ShipmentStatus.Arranged,
            CreatedAt = DateTime.UtcNow,
            ArrangedAt = DateTime.UtcNow
        };

        db.Shipments.Add(shipment);

        var result = new ShippingArranged(command.OrderId, trackingNumber, DateTime.UtcNow);
        return new ArrangeResult(true, null, result);
    }

    public static async Task<CancelResult> CancelAsync(ShippingDbContext db, CancelShipping command)
    {
        var cached = await IdempotencyHelper.CheckAsync<ShippingCancelled>(db, command.OrderId, "CancelShipping");
        if (cached is not null)
            return new CancelResult(true, cached);

        var shipment = await db.Shipments.FirstOrDefaultAsync(s => s.OrderId == command.OrderId);
        if (shipment is not null)
            shipment.Status = ShipmentStatus.Cancelled;

        var result = new ShippingCancelled(command.OrderId);
        return new CancelResult(true, result);
    }
}

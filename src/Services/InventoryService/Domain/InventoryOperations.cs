using Microsoft.EntityFrameworkCore;
using InventoryService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace InventoryService.Domain;

public record ReserveResult(bool Success, string? Error, InventoryReserved? Event);
public record ReleaseResult(bool Success, InventoryReleased? Event);

public static class InventoryOperations
{
    private static readonly Random Rng = new();

    // Failure-injection toggle for the COMPENSATION step only.
    // ReserveAsync is unaffected — set to 100 to make the happy path reach the
    // compensation phase, then have ReleaseAsync fail. Used by Test M
    // (rollback-failure) to reproduce the lecturer's scenario:
    //   "rollback starts → during rollback Inventory service fail → does the
    //   system recover or stay inconsistent?"
    // Default is 0 so all other benchmarks are unaffected.
    public static int ReleaseFailureRatePercent { get; set; } = 0;

    public static async Task<ReserveResult> ReserveAsync(InventoryDbContext db, ReserveInventory command)
    {
        var cached = await IdempotencyHelper.CheckAsync<InventoryReserved>(db, command.OrderId, "ReserveInventory");
        if (cached is not null)
            return new ReserveResult(true, null, cached);

        foreach (var item in command.Items)
        {
            var product = await db.Products.FirstOrDefaultAsync(p => p.Id == item.ProductId);
            if (product is null)
                return new ReserveResult(false, $"Product {item.ProductId} not found", null);

            var available = product.StockQuantity - product.ReservedQuantity;
            if (available < item.Quantity)
                return new ReserveResult(false,
                    $"Insufficient stock for {product.Name}. Available: {available}, Requested: {item.Quantity}", null);

            product.ReservedQuantity += item.Quantity;

            db.Reservations.Add(new Reservation
            {
                Id = Guid.NewGuid(),
                OrderId = command.OrderId,
                ProductId = item.ProductId,
                Quantity = item.Quantity,
                Status = ReservationStatus.Pending,
                CreatedAt = DateTime.UtcNow
            });
        }

        // SaveChanges is NOT called here — caller handles it (for outbox atomicity)
        var result = new InventoryReserved(command.OrderId, DateTime.UtcNow);
        return new ReserveResult(true, null, result);
    }

    public static async Task<ReleaseResult> ReleaseAsync(InventoryDbContext db, ReleaseInventory command)
    {
        // Throw BEFORE the idempotency check so a permanently-failing Release does
        // not poison the idempotency cache. On retry (after rate is set back to 0)
        // the operation runs fresh and can succeed.
        if (ReleaseFailureRatePercent > 0 && Rng.Next(100) < ReleaseFailureRatePercent)
            throw new InvalidOperationException("Simulated InventoryService.Release failure (rollback-failure test)");

        var cached = await IdempotencyHelper.CheckAsync<InventoryReleased>(db, command.OrderId, "ReleaseInventory");
        if (cached is not null)
            return new ReleaseResult(true, cached);

        var reservations = await db.Reservations
            .Where(r => r.OrderId == command.OrderId && r.Status != ReservationStatus.Released)
            .ToListAsync();

        foreach (var reservation in reservations)
        {
            reservation.Status = ReservationStatus.Released;

            var product = await db.Products.FirstOrDefaultAsync(p => p.Id == reservation.ProductId);
            if (product is not null)
                product.ReservedQuantity -= reservation.Quantity;
        }

        var result = new InventoryReleased(command.OrderId);
        return new ReleaseResult(true, result);
    }
}

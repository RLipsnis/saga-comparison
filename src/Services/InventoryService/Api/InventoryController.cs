using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using InventoryService.Domain;
using InventoryService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace InventoryService.Api;

[ApiController]
[Route("api/inventory")]
public class InventoryController : ControllerBase
{
    private readonly InventoryDbContext _db;
    private readonly ILogger<InventoryController> _logger;

    public InventoryController(InventoryDbContext db, ILogger<InventoryController> logger)
    {
        _db = db;
        _logger = logger;
    }

    [HttpPost("reserve")]
    public async Task<IActionResult> Reserve([FromBody] ReserveInventory command)
    {
        var result = await InventoryOperations.ReserveAsync(_db, command);

        if (!result.Success)
        {
            _logger.LogWarning("ReserveInventory failed for OrderId={OrderId}: {Error}", command.OrderId, result.Error);
            return Conflict(new InventoryReservationFailed(command.OrderId, result.Error!));
        }

        try
        {
            await _db.SaveChangesAsync();
        }
        catch (DbUpdateConcurrencyException)
        {
            _logger.LogWarning("Concurrency conflict reserving inventory for OrderId={OrderId}", command.OrderId);
            return Conflict(new InventoryReservationFailed(command.OrderId, "Concurrent modification, retry"));
        }

        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "ReserveInventory", result.Event!);

        _logger.LogInformation("Inventory reserved for OrderId={OrderId}", command.OrderId);
        return Ok(result.Event);
    }

    [HttpPost("release")]
    public async Task<IActionResult> Release([FromBody] ReleaseInventory command)
    {
        var result = await InventoryOperations.ReleaseAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "ReleaseInventory", result.Event!);

        _logger.LogInformation("Inventory released for OrderId={OrderId}", command.OrderId);
        return Ok(result.Event);
    }

    [HttpGet("products")]
    public async Task<IActionResult> GetProducts()
    {
        var products = await _db.Products
            .Select(p => new
            {
                p.Id,
                p.Name,
                p.Sku,
                p.Price,
                p.StockQuantity,
                p.ReservedQuantity,
                AvailableQuantity = p.StockQuantity - p.ReservedQuantity
            })
            .ToListAsync();

        return Ok(products);
    }

    [HttpPost("products/{id:guid}/restock")]
    public async Task<IActionResult> Restock(Guid id, [FromBody] RestockRequest request)
    {
        var product = await _db.Products.FirstOrDefaultAsync(p => p.Id == id);
        if (product is null) return NotFound();

        product.StockQuantity += request.Quantity;
        await _db.SaveChangesAsync();

        _logger.LogInformation("Restocked {Name} by {Qty}, new stock={Stock}", product.Name, request.Quantity, product.StockQuantity);
        return Ok(new { product.Id, product.Name, product.StockQuantity });
    }

    [HttpPost("reset")]
    public async Task<IActionResult> ResetInventory()
    {
        await _db.Reservations.ExecuteDeleteAsync();
        await _db.IdempotencyRecords.ExecuteDeleteAsync();

        var seedData = new Dictionary<Guid, (int Stock, int Reserved)>
        {
            [Guid.Parse("a1111111-1111-1111-1111-111111111111")] = (100_000, 0),
            [Guid.Parse("a2222222-2222-2222-2222-222222222222")] = (100_000, 0),
            [Guid.Parse("a3333333-3333-3333-3333-333333333333")] = (100_000, 0),
            [Guid.Parse("a4444444-4444-4444-4444-444444444444")] = (100_000, 0),
            [Guid.Parse("a5555555-5555-5555-5555-555555555555")] = (100_000, 0),
            [Guid.Parse("b1111111-1111-1111-1111-111111111111")] = (10, 0),
            [Guid.Parse("b2222222-2222-2222-2222-222222222222")] = (10, 0),
            [Guid.Parse("b3333333-3333-3333-3333-333333333333")] = (10, 0),
            [Guid.Parse("c1111111-1111-1111-1111-111111111111")] = (1, 0),
            [Guid.Parse("d1111111-1111-1111-1111-111111111111")] = (0, 0),
        };

        var products = await _db.Products.ToListAsync();
        foreach (var p in products)
        {
            if (seedData.TryGetValue(p.Id, out var seed))
            {
                p.StockQuantity = seed.Stock;
                p.ReservedQuantity = seed.Reserved;
            }
        }

        await _db.SaveChangesAsync();
        _logger.LogInformation("Inventory reset to seed data");
        return Ok(new { message = "Inventory reset to seed data" });
    }
}

public record RestockRequest(int Quantity);

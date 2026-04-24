using Microsoft.AspNetCore.Mvc;
using ShippingService.Domain;
using ShippingService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace ShippingService.Api;

[ApiController]
[Route("api/shipping")]
public class ShippingController : ControllerBase
{
    private readonly ShippingDbContext _db;
    private readonly ILogger<ShippingController> _logger;

    public ShippingController(ShippingDbContext db, ILogger<ShippingController> logger)
    {
        _db = db;
        _logger = logger;
    }

    [HttpPost("arrange")]
    public async Task<IActionResult> Arrange([FromBody] ArrangeShipping command)
    {
        var result = await ShippingOperations.ArrangeAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "ArrangeShipping", result.Event!);

        _logger.LogInformation("Shipping arranged for OrderId={OrderId}, Tracking={Tracking}", command.OrderId, result.Event!.TrackingNumber);
        return Ok(result.Event);
    }

    [HttpPost("cancel")]
    public async Task<IActionResult> Cancel([FromBody] CancelShipping command)
    {
        var result = await ShippingOperations.CancelAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "CancelShipping", result.Event!);

        _logger.LogInformation("Shipping cancelled for OrderId={OrderId}", command.OrderId);
        return Ok(result.Event);
    }
}
